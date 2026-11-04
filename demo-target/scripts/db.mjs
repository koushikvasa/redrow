import postgres from 'postgres'

// The tables leaky.sql creates. These scripts drop and delete them, so they refuse to run
// on a database holding anything else.
const CARENOTE_TABLES = new Set(['profiles', 'patients', 'visit_notes', 'appointments', 'invoices'])

function loadRootEnv() {
  try {
    process.loadEnvFile(new URL('../../.env', import.meta.url))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

loadRootEnv()

export function requireEnv(name) {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set. Add it to .env (see .env.example).`)
  }
  return value
}

/** The project ref in DEMO_SUPABASE_URL. Also keeps the service key off anything but Supabase over TLS. */
export function demoSupabaseUrl() {
  const url = new URL(requireEnv('DEMO_SUPABASE_URL'))
  const match = /^([a-z0-9]+)\.supabase\.co$/.exec(url.hostname)
  if (url.protocol !== 'https:' || match === null) {
    throw new Error('DEMO_SUPABASE_URL must look like https://<project-ref>.supabase.co')
  }
  return { origin: url.origin, ref: match[1] }
}

/** Supabase's pooler names the project in the login: `postgres.<ref>`. */
function refFromDbUrl() {
  const login = decodeURIComponent(new URL(requireEnv('DEMO_DB_URL')).username)
  const dot = login.indexOf('.')
  return dot === -1 ? undefined : login.slice(dot + 1)
}

/**
 * These scripts drop tables and delete every row, and `public.profiles` is a common table
 * in real Supabase apps. So a wrong DEMO_DB_URL must fail here, before any write: the url
 * has to name the same project as DEMO_SUPABASE_URL, and `public` may hold only CareNote.
 */
async function assertIsDemoDatabase(sql) {
  const { ref } = demoSupabaseUrl()
  if (refFromDbUrl() !== ref) {
    throw new Error(
      `Refusing to run: DEMO_DB_URL and DEMO_SUPABASE_URL don't name the same project. Expected the login postgres.${ref}.`,
    )
  }
  const rows = await sql`select tablename from pg_tables where schemaname = 'public' order by 1`
  const foreign = rows.map((row) => row.tablename).filter((name) => !CARENOTE_TABLES.has(name))
  if (foreign.length > 0) {
    throw new Error(
      `Refusing to run on project ${ref}: public has tables that aren't CareNote's: ${foreign.join(', ')}. ` +
        'DEMO_DB_URL may point at a real project. These scripts drop tables and delete rows.',
    )
  }
  process.stdout.write(`Target: project ${ref}\n`)
}

/** The demo database, checked to really be the demo before the caller can write anything. */
export async function connectToDemoDb() {
  const sql = postgres(requireEnv('DEMO_DB_URL'), { max: 1, ssl: 'require', prepare: false, onnotice: () => {} })
  try {
    await assertIsDemoDatabase(sql)
    return sql
  } catch (error) {
    await sql.end({ timeout: 5 })
    throw error
  }
}

function secretsInEnv() {
  const password = URL.canParse(process.env.DEMO_DB_URL ?? '') ? new URL(process.env.DEMO_DB_URL).password : ''
  return [password, decodeURIComponent(password), process.env.DEMO_SERVICE_ROLE_KEY ?? ''].filter((s) => s !== '')
}

/** Runs a script body, printing only a scrubbed message on failure, so no credential can leak. */
export async function main(run) {
  try {
    await run()
  } catch (error) {
    const message = secretsInEnv().reduce(
      (text, secret) => text.split(secret).join('***'),
      String(error?.message ?? error),
    )
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  }
}
