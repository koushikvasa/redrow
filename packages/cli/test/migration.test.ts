import { describe, expect, it } from 'vitest'
import { MigrationError, parseMigration, parseModelOutput, splitStatements } from '../src/fix/migration'

const wrap = (body: string): string => `begin;\n${body}\ncommit;\n`
const parsedBody = (body: string): readonly string[] => parseMigration(wrap(body)).statements

describe('splitStatements', () => {
  it('splits on semicolons and keeps the comments before each statement', () => {
    const result = splitStatements('-- one\nselect 1;\n/* two */ select 2;')
    expect(result.map((s) => s.sql)).toEqual(['select 1', 'select 2'])
    expect(result[0]?.comments).toEqual(['one'])
    expect(result[1]?.comments).toEqual(['two'])
  })

  it.each([
    ['a single-quoted string', "select ';'; select 2", "select ';'"],
    ['an escaped quote', "select 'it''s;'; select 2", "select 'it''s;'"],
    ['an E-string with a backslash', "select E'a\\';b'; select 2", "select E'a\\';b'"],
    ['a double-quoted identifier', 'select ";"; select 2', 'select ";"'],
    ['a dollar-quoted body', 'select $$a;b$$; select 2', 'select $$a;b$$'],
    ['a tagged dollar-quoted body', 'select $x$a;$$;b$x$; select 2', 'select $x$a;$$;b$x$'],
  ])('does not split inside %s', (_label, input, first) => {
    const result = splitStatements(input)
    expect(result[0]?.sql).toBe(first)
    expect(result).toHaveLength(2)
  })

  it('does not treat a comment marker inside a string as a comment', () => {
    expect(splitStatements("select '-- no'; select 2")[0]?.sql).toBe("select '-- no'")
  })

  it('handles nested block comments', () => {
    expect(splitStatements('/* a /* b */ c */ select 1')[0]?.sql).toBe('select 1')
  })

  // Each of these is a place where a splitter can read SQL differently from Postgres, and
  // so validate one thing while the file holds another.
  describe('reads SQL the way Postgres does', () => {
    it('ends a line comment at a carriage return too', () => {
      expect(splitStatements('-- c\rdrop table x;').map((s) => s.sql)).toEqual(['drop table x'])
    })

    it('treats a comment as whitespace, so it cannot join two words', () => {
      expect(splitStatements('drop policy p on t/**/cascade')[0]?.sql).toBe('drop policy p on t cascade')
      expect(splitStatements('drop policy p on t--x\ncascade')[0]?.sql).toBe('drop policy p on t cascade')
    })

    it('does not see a dollar quote right after a non-ASCII identifier character', () => {
      expect(splitStatements('select é$$; commit; select 1$$').map((s) => s.sql)).toContain('commit')
    })

    it('does not see an E-string right after a non-ASCII identifier character', () => {
      expect(splitStatements("select éE'\\'; commit; select 'x'").map((s) => s.sql)).toContain('commit')
    })

    it('does not treat a tag starting with a digit as a dollar quote', () => {
      expect(splitStatements('select $1$; commit; select 1$').map((s) => s.sql)).toContain('commit')
    })

    it('accepts a non-ASCII dollar-quote tag, which Postgres allows', () => {
      expect(splitStatements('select $é$a;b$é$; select 2')).toHaveLength(2)
    })
  })

  it('keeps a statement with no final semicolon', () => {
    expect(splitStatements('select 1').map((s) => s.sql)).toEqual(['select 1'])
  })

  it.each([
    ['a string', "select 'oops"],
    ['an identifier', 'select "oops'],
    ['a dollar quote', 'select $$oops'],
    ['a block comment', 'select 1 /* oops'],
  ])('rejects an unterminated %s, rather than guessing where it ends', (_label, input) => {
    expect(() => splitStatements(input)).toThrow(MigrationError)
  })
})

describe('parseMigration', () => {
  const rule = '-- RR003: public.t\n'

  it('returns the statements between begin and commit, without them', () => {
    const body = `${rule}alter table public.t enable row level security;`
    expect(parsedBody(body)).toEqual(['alter table public.t enable row level security'])
  })

  describe('code fences', () => {
    const body = wrap(`${rule}alter table public.t enable row level security;`)

    it('unwraps one that wraps all of a model reply', () => {
      expect(parseModelOutput('```sql\n' + body + '```').statements).toHaveLength(1)
      expect(parseModelOutput('\n```\n' + body + '```\n').statements).toHaveLength(1)
    })

    it('leaves a reply with no fence alone', () => {
      expect(parseModelOutput(body).statements).toHaveLength(1)
    })

    it('does not go looking for a fence inside other text', () => {
      expect(() => parseModelOutput('sure!\n```sql\n' + body + '```')).toThrow(MigrationError)
    })

    // Template text holds catalog strings, and a fence in a name must not replace the migration.
    it('is never unwrapped for a template', () => {
      expect(() => parseMigration('```sql\n' + body + '```')).toThrow(MigrationError)
    })
  })

  describe('the text it returns', () => {
    const statement = 'alter table public.t enable row level security'

    it('keeps comments, and begin and commit', () => {
      const { text } = parseMigration(`-- header\nbegin;\n${rule}${statement};\ncommit;\n`)
      expect(text).toContain('-- header')
      expect(text).toContain('-- RR003: public.t')
      expect(text).toMatch(/^begin;$/m)
      expect(text.trimEnd().endsWith('commit;')).toBe(true)
    })

    it('holds exactly the validated statements, so the file cannot differ from what was checked', () => {
      const { text, statements } = parseMigration(wrap(`${rule}/* note */ ${statement};`))
      const reread = splitStatements(text).map((s) => s.sql)
      expect(reread).toEqual(['begin', ...statements, 'commit'])
    })

    it('rejects SQL hidden behind a carriage return in a comment', () => {
      const hidden = `begin;\n-- RR003: x\rdrop table public.patients;\n${statement};\ncommit;`
      expect(() => parseMigration(hidden)).toThrow(/not allowed/i)
    })

    it('writes each comment on one line', () => {
      const { text } = parseMigration(wrap(`/* RR003\nline two\rline three */ ${statement};`))
      expect(text.split('\n').filter((line) => line.includes('line three'))).toHaveLength(1)
      expect(text).not.toContain('\r')
    })
  })

  it.each([
    ['no begin', `${rule}alter table t enable row level security;\ncommit;`],
    ['no commit', `begin;\n${rule}alter table t enable row level security;`],
    ['commit first', `commit;\n${rule}alter table t enable row level security;\nbegin;`],
    ['nothing inside', 'begin;\ncommit;'],
  ])('rejects %s', (_label, text) => {
    expect(() => parseMigration(text)).toThrow(MigrationError)
  })

  describe('rejects anything but the schema changes a fix needs', () => {
    it.each([
      // Ending the transaction is the one that matters most: inside a "rolled back"
      // validation, a COMMIT would make everything before it permanent.
      ['commit', 'commit'],
      ['end', 'end'],
      ['rollback', 'rollback'],
      ['a nested begin', 'begin'],
      ['start transaction', 'start transaction'],
      ['savepoint', 'savepoint s'],
      ['prepare transaction', "prepare transaction 'x'"],
      ['set role', 'set role postgres'],
      ['set', "set search_path = 'x'"],
      ['delete', 'delete from public.patients'],
      ['update', 'update public.patients set dob = null'],
      ['insert', "insert into public.patients (id) values ('x')"],
      ['truncate', 'truncate public.patients'],
      ['drop table', 'drop table public.patients'],
      ['drop schema', 'drop schema public cascade'],
      ['select', 'select * from public.patients'],
      ['copy to a program', "copy public.patients to program 'curl evil'"],
      ['do block', 'do $$ begin perform 1; end $$'],
      ['create function', 'create function x() returns int language sql as $$ select 1 $$'],
      ['create role', "create role evil login password 'x'"],
      ['alter role', 'alter role postgres superuser'],
      ['grant', 'grant all on public.patients to anon'],
      ['disable rls', 'alter table public.t disable row level security'],
      ['drop a column', 'alter table public.t drop column email'],
      ['alter a view definition', 'alter view public.v owner to anon'],
      ['turn security_invoker off', 'alter view public.v set (security_invoker = false)'],
      ['rename a policy', 'alter policy p on public.t rename to q'],
      ['widen a policy to new roles', 'alter policy p on public.t to anon using (true)'],
      ['a unique index, which can report row values', 'create unique index on public.t (email)'],
      ['drop policy cascade', 'drop policy p on public.t cascade'],
      ['revoke cascade', 'revoke select on public.t from anon cascade'],
      ['cascade hidden by a comment', 'drop policy p on public.t/**/cascade'],
      // Anything evaluated per row can put a value in an error message or run a function.
      ['an index expression', 'create index on public.patients ((full_name::int))'],
      ['an index with a function', 'create index on public.patients ((public.evil(ssn)))'],
      ['a partial index', 'create index on public.patients (id) where (ssn::uuid is not null)'],
      ['a concurrent index', 'create index concurrently on public.t (c)'],
      // A new policy with no TO clause applies to PUBLIC, so anon gets it.
      ['a policy with no roles', 'create policy a on public.t using (x = (select auth.uid()))'],
      ['a policy for anon', 'create policy a on public.t to anon using (x = (select auth.uid()))'],
      ['a policy for public', 'create policy a on public.t for all to public using (x = (select auth.uid()))'],
      ['a policy for several roles', 'create policy a on public.t to authenticated, anon using (x = (select auth.uid()))'],
      ['an open create', 'create policy a on public.t for select to authenticated using (true)'],
      ['an open check', 'create policy a on public.t for insert to authenticated with check ((true))'],
      ['an open alter', 'alter policy p on public.t using (true)'],
      ['an open alter check', 'alter policy p on public.t with check ( true )'],
      // Scope checks one object per statement, so a statement may only name one.
      ['a revoke on several functions', 'revoke execute on function public.f(text), auth.uid() from authenticated'],
      ['a revoke on several tables', 'revoke all on public.t, public.u from anon'],
    ])('%s', (_label, statement) => {
      expect(() => parsedBody(`${rule}${statement};`)).toThrow(/not allowed/i)
    })

    it('names the offending statement in the error', () => {
      expect(() => parsedBody(`${rule}drop table public.patients;`)).toThrow(/drop table public\.patients/)
    })

    it('cannot be fooled by hiding a statement behind a comment', () => {
      expect(() => parsedBody(`${rule}alter table public.t enable row level security; /* x */ commit;`)).toThrow(
        /not allowed/i,
      )
    })
  })

  describe('allows the schema changes a fix needs', () => {
    it.each([
      ['enable rls', 'alter table "public"."T" enable row level security'],
      ['force rls', 'alter table only public.t force row level security'],
      ['create policy', 'create policy "a b" on public.t for select to authenticated using (x = (select auth.uid()))'],
      ['alter policy using', 'alter policy "a""b" on "public"."t" using (x = (select auth.uid()))'],
      ['alter policy check', 'alter policy p on public.t with check (x = (select auth.uid()))'],
      ['alter policy both', 'alter policy p on public.t using (a) with check (b)'],
      ['drop policy', 'drop policy p on public.t'],
      ['drop policy if exists', 'drop policy if exists "p q" on public.t'],
      ['view invoker', 'alter view public.v set (security_invoker = true)'],
      ['view invoker on', 'alter view "public"."v" set (security_invoker = on)'],
      ['create index', 'create index if not exists "i" on "public"."t" ("c")'],
      ['unnamed index', 'create index on public.t (c)'],
      ['multi-column index', 'create index on public.t (a, "B")'],
      ['a role-limited policy with the for clause first', 'create policy a on public.t for all to authenticated using (x = 1) with check (x = 1)'],
      ['a string that merely mentions true', "alter policy p on public.t using (x = 'true')"],
      // A table's name must not be able to abort the fix for a whole database.
      ['a table name that looks like an open policy', 'alter table public."x using(true)" enable row level security'],
      ['a string that looks like an open policy', "alter policy p on public.t using (x = 'using (true)')"],
      ['revoke execute', 'revoke execute on function public.f(q text) from anon, authenticated, public'],
      ['revoke on a table', 'revoke all on public.t from anon, authenticated'],
      ['revoke writes', 'revoke insert, update, delete on public.t from anon'],
      ['upper case', 'ALTER TABLE public.t ENABLE ROW LEVEL SECURITY'],
    ])('%s', (_label, statement) => {
      expect(parsedBody(`${rule}${statement};`)).toEqual([statement])
    })
  })

  describe('rule comments', () => {
    const statement = 'alter table public.t enable row level security;'

    it('requires a rule id before the first statement', () => {
      expect(() => parsedBody(statement)).toThrow(/rule id/i)
      expect(() => parsedBody(`-- no id here\n${statement}`)).toThrow(/rule id/i)
    })

    it('lets later statements in a block inherit it', () => {
      expect(parsedBody(`${rule}${statement}\n${statement}`)).toHaveLength(2)
    })
  })
})
