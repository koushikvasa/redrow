// src/tx.ts
var PROBE_ROLES = /* @__PURE__ */ new Set(["anon", "authenticated"]);
var SQLSTATE = /^[0-9A-Z]{5}$/;
var RollbackSignal = class extends Error {
};
var ImpersonationError = class extends Error {
};
var TxSetupError = class extends Error {
  code;
  constructor(message, code) {
    super(message);
    this.code = code;
  }
};
var NOT_ABOUT_THE_STATEMENT = /^(08|28|53|57P)/;
function sqlStateOf(error) {
  if (error instanceof TxSetupError) return void 0;
  if (typeof error !== "object" || error === null || !("code" in error)) return void 0;
  const { code } = error;
  return typeof code === "string" && SQLSTATE.test(code) && !NOT_ABOUT_THE_STATEMENT.test(code) ? code : void 0;
}
function asSetupError(error) {
  const hasServerCode = error instanceof Error && "code" in error && typeof error.code === "string" && SQLSTATE.test(error.code);
  return hasServerCode ? new TxSetupError(error.message, error.code) : error;
}
async function inRolledBackTx(sql, fn, { readOnly = false } = {}) {
  const mode = `isolation level repeatable read${readOnly ? " read only" : ""}`;
  let out;
  let isSetUp = false;
  try {
    await sql.begin(mode, async (tx) => {
      await tx`set local statement_timeout = '5s'`;
      await tx`set local lock_timeout = '1s'`;
      isSetUp = true;
      out = await fn(tx);
      throw new RollbackSignal();
    });
  } catch (error) {
    if (error instanceof RollbackSignal) return out;
    throw isSetUp ? error : asSetupError(error);
  }
  throw new Error("The probe transaction ended without rolling back");
}
async function switchRole(tx, role) {
  try {
    await tx.unsafe(`set local role ${role}`);
  } catch (error) {
    if (sqlStateOf(error) === void 0) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new ImpersonationError(
      `The connecting role can't act as ${role}: ${reason}. Connect as the postgres role.`
    );
  }
}
async function impersonate(tx, role, sub) {
  if (!PROBE_ROLES.has(role)) {
    throw new Error(`Refusing to impersonate role outside the whitelist: ${role}`);
  }
  const claims = JSON.stringify(sub === void 0 ? { role } : { sub, role });
  await switchRole(tx, role);
  await tx`select set_config('request.jwt.claims', ${claims}, true),
                  set_config('request.jwt.claim.sub', ${sub ?? ""}, true),
                  set_config('request.jwt.claim.role', ${role}, true)`;
}
async function stopImpersonating(tx) {
  await tx.unsafe("set local role none");
}

// src/actors.ts
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function tallyOwners(perTable) {
  const uuidOwners = perTable.flat().filter(({ owner }) => UUID.test(owner));
  const owners = [...new Set(uuidOwners.map(({ owner }) => owner))];
  return owners.map((owner) => {
    const entries = uuidOwners.filter((entry) => entry.owner === owner);
    return { owner, tables: entries.length, rows: entries.reduce((sum, { n }) => sum + n, 0) };
  });
}
function chooseActors(perTable, pinnedUserA) {
  const ranked = tallyOwners(perTable).sort((a, b) => b.tables - a.tables || b.rows - a.rows).map(({ owner }) => owner);
  const [first, second] = pinnedUserA === void 0 ? ranked : [pinnedUserA, ...ranked.filter((owner) => owner !== pinnedUserA)];
  return {
    ...first === void 0 ? {} : { userA: first },
    ...second === void 0 ? {} : { userB: second }
  };
}
async function findUserIdByEmail(sql, email) {
  try {
    const rows = await sql`select id::text as id from auth.users where lower(email) = lower(${email}) limit 1`;
    return rows[0]?.id;
  } catch (error) {
    if (sqlStateOf(error) === void 0) throw error;
    return void 0;
  }
}
async function randomUserId(sql) {
  const rows = await sql`select gen_random_uuid()::text as id`;
  const id = rows[0]?.id;
  if (id === void 0) throw new Error("gen_random_uuid() returned no row");
  return id;
}
async function resolveActors(sql, found) {
  return {
    userA: found.userA ?? await randomUserId(sql),
    userB: found.userB ?? await randomUserId(sql)
  };
}

// src/concurrency.ts
async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// src/declared.ts
var ROLES_ANON_ACTS_AS = /* @__PURE__ */ new Set(["anon", "public"]);
var REMEDIATION = "None needed while this table is meant to be public. If it is not, remove it from publicTables.";
var isDeclared = (table, publicTables) => publicTables.includes(`${table.schema}.${table.table}`) || table.schema === "public" && publicTables.includes(table.table);
var hasWriteGrant = (p) => p.insert || p.update || p.delete;
var appliesToAnon = (policy) => policy.roles.some((role) => ROLES_ANON_ACTS_AS.has(role));
var policiesOn = (table, policies) => policies.filter((p) => p.schema === table.schema && p.table === table.table);
function hasWriteExposure(table, policies) {
  if (!table.rlsEnabled) return hasWriteGrant(table.anon) || hasWriteGrant(table.authenticated);
  return policies.some((p) => p.cmd !== "SELECT" && p.permissive && appliesToAnon(p));
}
function isAnonRead(finding, policies) {
  switch (finding.ruleId) {
    case "RR001":
    case "RR101":
      return true;
    case "RR003":
      return finding.probe === void 0 && policies.some((p) => p.name === finding.policy && p.cmd === "SELECT" && appliesToAnon(p));
    default:
      return false;
  }
}
var sensitiveNote = (table) => table.sensitive.length === 0 ? "" : ` Sensitive columns: ${table.sensitive.join(", ")}.`;
var withoutSensitiveNote = (detail) => detail.replace(/ Sensitive columns: .*$/, "");
function applyDeclaredExposure(findings, introspection, publicTables, noWiderThanAnon = /* @__PURE__ */ new Set()) {
  return findings.flatMap((finding) => {
    const table = introspection.tables.find((t) => t.schema === finding.schema && t.table === finding.table);
    if (table === void 0 || !isDeclared(table, publicTables)) return [finding];
    const policies = policiesOn(table, introspection.policies);
    if (hasWriteExposure(table, policies)) return [finding];
    if (finding.ruleId === "RR102" && noWiderThanAnon.has(`${table.schema}.${table.table}`)) return [];
    if (!isAnonRead(finding, policies)) return [finding];
    return [
      {
        ...finding,
        severity: "info",
        title: "Declared exposure",
        detail: `Declared exposure: ${withoutSensitiveNote(finding.detail)}${sensitiveNote(table)}`,
        fixHint: REMEDIATION
      }
    ];
  });
}

// src/rules.ts
var quoteIdent = (name) => `"${name.replace(/"/g, '""')}"`;
var relation = (c) => `${quoteIdent(c.schema)}.${c.table === void 0 ? "<table>" : quoteIdent(c.table)}`;
var ownerCheck = (c) => `${c.column === void 0 ? "<owner_column>" : quoteIdent(c.column)} = (select auth.uid())`;
var policyName = (c) => c.policy === void 0 ? "<policy>" : quoteIdent(c.policy);
var enableRlsWithOwnerPolicy = (c) => `alter table ${relation(c)} enable row level security; create policy "owner_access" on ${relation(c)} for all to authenticated using (${ownerCheck(c)}) with check (${ownerCheck(c)});`;
var scopeReadsToOwner = (c) => `create policy "owner_read" on ${relation(c)} for select to authenticated using (${ownerCheck(c)}); -- then drop any policy that uses "true" or a role-only check for reads`;
var scopeWritesToOwner = (c) => `Limit ${relation(c)} write policies to the owner: using (${ownerCheck(c)}) with check (${ownerCheck(c)}).`;
var revokeAnonWrites = (c) => `revoke insert, update, delete on ${relation(c)} from anon;`;
var RULES = {
  RR001: {
    severity: "critical",
    title: "RLS disabled: table is publicly readable through the API",
    fixHint: enableRlsWithOwnerPolicy
  },
  RR002: {
    severity: "high",
    title: "RLS disabled on a table API roles can access",
    fixHint: enableRlsWithOwnerPolicy
  },
  RR003: {
    severity: "high",
    title: "Read policy matches every row (USING true)",
    fixHint: (c) => `alter policy ${policyName(c)} on ${relation(c)} using (${ownerCheck(c)});`
  },
  RR004: {
    severity: "medium",
    title: "UPDATE policy has no explicit WITH CHECK",
    fixHint: (c) => `alter policy ${policyName(c)} on ${relation(c)} with check (${ownerCheck(c)});`
  },
  RR005: {
    severity: "medium",
    title: "INSERT policy does not check row ownership",
    fixHint: (c) => `alter policy ${policyName(c)} on ${relation(c)} with check (${ownerCheck(c)});`
  },
  RR006: {
    severity: "high",
    title: "View bypasses RLS",
    fixHint: (c) => c.materialized === true ? `revoke select on ${relation(c)} from anon, authenticated;` : `alter view ${relation(c)} set (security_invoker = true);`
  },
  RR007: {
    severity: "high",
    title: "SECURITY DEFINER function callable from the API",
    fixHint: (c) => `revoke execute on function ${quoteIdent(c.schema)}.${c.functionName === void 0 ? "<function>" : quoteIdent(c.functionName)}(${c.functionArgs ?? ""}) from public, anon, authenticated; -- then grant it only to the roles that need it, or make it security invoker`
  },
  RR008: {
    severity: "low",
    title: "Policy re-evaluates auth.uid() for every row",
    fixHint: (c) => `In policy ${policyName(c)} on ${relation(c)}, replace auth.uid() with (select auth.uid()) so it is evaluated once per query.`
  },
  RR009: {
    severity: "low",
    title: "Owner column used in a policy has no index",
    fixHint: (c) => `create index on ${relation(c)} (${c.column === void 0 ? "<owner_column>" : quoteIdent(c.column)});`
  },
  RR010: {
    severity: "medium",
    title: "RLS enabled with no policies, so API roles see nothing",
    fixHint: (c) => `revoke all on ${relation(c)} from anon, authenticated; -- if only the service role should reach this table; otherwise add an owner-scoped policy instead`
  },
  RR101: {
    severity: "critical",
    title: "Anonymous users can read an owned or sensitive table",
    fixHint: enableRlsWithOwnerPolicy
  },
  RR102: {
    severity: "critical",
    title: "A signed-in user can read other users' rows",
    fixHint: scopeReadsToOwner
  },
  RR103: {
    severity: "critical",
    title: "A signed-in user can update other users' rows",
    fixHint: scopeWritesToOwner
  },
  RR104: {
    severity: "critical",
    title: "A signed-in user can delete other users' rows",
    fixHint: scopeWritesToOwner
  },
  RR105: {
    severity: "high",
    title: "A signed-in user can insert a row owned by someone else",
    fixHint: scopeWritesToOwner
  },
  RR106: {
    severity: "high",
    title: "Anonymous users can write to a table",
    fixHint: revokeAnonWrites
  }
};
function makeFinding(ruleId, context, detail, severity) {
  const rule = RULES[ruleId];
  return {
    ruleId,
    severity: severity ?? rule.severity,
    schema: context.schema,
    ...context.table === void 0 ? {} : { table: context.table },
    ...context.policy === void 0 ? {} : { policy: context.policy },
    title: rule.title,
    detail,
    fixHint: rule.fixHint(context)
  };
}

// src/static.ts
var API_ROLES = /* @__PURE__ */ new Set(["public", "anon", "authenticated"]);
var appliesToApi = (policy) => policy.roles.some((role) => API_ROLES.has(role));
var grantsApiAccess = (policy) => policy.permissive && appliesToApi(policy);
var hasAnyPrivilege = (p) => p.select || p.insert || p.update || p.delete;
var isAlwaysTrue = (expression) => expression !== null && expression.replace(/[()\s]/g, "").toLowerCase() === "true";
var qualifiedName = (table) => `${table.schema}.${table.table}`;
var tableContext = (table, policy) => ({
  schema: table.schema,
  table: table.table,
  ...table.ownerColumn === void 0 ? {} : { column: table.ownerColumn },
  ...policy === void 0 ? {} : { policy: policy.name }
});
var sensitiveSuffix = (table) => table.sensitive.length === 0 ? "" : ` Sensitive columns: ${table.sensitive.join(", ")}.`;
var checkRlsDisabled = (table) => {
  if (table.rlsEnabled) return [];
  if (table.anon.select) {
    return [
      makeFinding(
        "RR001",
        tableContext(table),
        `RLS is off and anon can SELECT ${qualifiedName(table)}, so anyone holding the public anon key can read it through the API.${sensitiveSuffix(table)}`
      )
    ];
  }
  const holders = [
    hasAnyPrivilege(table.anon) ? "anon" : null,
    hasAnyPrivilege(table.authenticated) ? "authenticated" : null
  ].filter((role) => role !== null);
  if (holders.length === 0) return [];
  return [
    makeFinding(
      "RR002",
      tableContext(table),
      `RLS is off on ${qualifiedName(table)}, so ${holders.join(" and ")} can use every privilege they hold on every row.${sensitiveSuffix(table)}`
    )
  ];
};
var checkOpenReadPolicies = (table, policies) => {
  if (table.ownerColumn === void 0 && table.sensitive.length === 0) return [];
  return policies.filter((p) => (p.cmd === "SELECT" || p.cmd === "ALL") && grantsApiAccess(p) && isAlwaysTrue(p.qual)).map(
    (p) => makeFinding(
      "RR003",
      tableContext(table, p),
      `Policy "${p.name}" on ${qualifiedName(table)} has USING (true), so every member of ${p.roles.join(", ")} can read every row.${sensitiveSuffix(table)}`
    )
  );
};
var checkMissingWithCheck = (table, policies) => policies.filter(
  (p) => (p.cmd === "UPDATE" || p.cmd === "ALL") && grantsApiAccess(p) && p.qual !== null && p.withCheck === null
).map(
  (p) => makeFinding(
    "RR004",
    tableContext(table, p),
    `Policy "${p.name}" on ${qualifiedName(table)} has no WITH CHECK, so Postgres reuses USING to check new rows. Rows can only be re-owned if USING is not owner-scoped; an explicit WITH CHECK states the rule either way.`
  )
);
var checkOpenInsertPolicies = (table, policies) => {
  if (table.ownerColumn === void 0) return [];
  return policies.filter(
    (p) => p.cmd === "INSERT" && grantsApiAccess(p) && (p.withCheck === null || isAlwaysTrue(p.withCheck))
  ).map(
    (p) => makeFinding(
      "RR005",
      tableContext(table, p),
      p.withCheck === null ? `INSERT policy "${p.name}" on ${qualifiedName(table)} has no WITH CHECK, which Postgres treats as deny: it denies every insert, which is probably not what was intended.` : `INSERT policy "${p.name}" on ${qualifiedName(table)} has WITH CHECK (true), so a signed-in user can insert a row with any owner in ${table.ownerColumn}.`
    )
  );
};
var checkNoPolicies = (table, policies) => {
  const hasApiPrivileges = hasAnyPrivilege(table.anon) || hasAnyPrivilege(table.authenticated);
  if (!table.rlsEnabled || policies.length > 0 || !hasApiPrivileges) return [];
  return [
    makeFinding(
      "RR010",
      tableContext(table),
      `RLS is on with no policies on ${qualifiedName(table)}, so API roles get no rows despite holding privileges. This is usually a missing policy.`
    )
  ];
};
var WRAPPED_AUTH_UID = /\(\s*SELECT\s+\(?\s*auth\.uid\(\)\s*\)?(?:::\w+)?(?:\s+AS\s+\w+)?\s*\)/gi;
function usesBareAuthUid(expression) {
  return /auth\.uid\(\)/i.test(expression.replace(WRAPPED_AUTH_UID, ""));
}
function wrapBareAuthUid(expression) {
  const eitherForm = new RegExp(`${WRAPPED_AUTH_UID.source}|auth\\.uid\\(\\)`, "gi");
  return expression.replace(
    eitherForm,
    (match) => match.toLowerCase() === "auth.uid()" ? "( SELECT auth.uid() AS uid)" : match
  );
}
var policyExpressions = (policy) => [policy.qual, policy.withCheck].filter((e) => e !== null);
var checkBareAuthUid = (table, policies) => policies.filter((p) => appliesToApi(p) && policyExpressions(p).some(usesBareAuthUid)).map(
  (p) => makeFinding(
    "RR008",
    tableContext(table, p),
    `Policy "${p.name}" on ${qualifiedName(table)} calls auth.uid() directly, so it is re-evaluated for every row scanned.`
  )
);
var referencesColumn = (expression, column) => {
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(expression);
};
var checkUnindexedOwnerColumn = (table, policies) => {
  const owner = table.ownerColumn;
  if (owner === void 0 || table.columns.some((c) => c.name === owner && c.indexed)) return [];
  const usedInPolicy = policies.some(
    (p) => appliesToApi(p) && policyExpressions(p).some((e) => referencesColumn(e, owner))
  );
  if (!usedInPolicy) return [];
  return [
    makeFinding(
      "RR009",
      tableContext(table),
      `${qualifiedName(table)}.${owner} is used in a policy but no index leads with it, so each query scans the table.`
    )
  ];
};
var TABLE_RULES = [
  checkRlsDisabled,
  checkOpenReadPolicies,
  checkMissingWithCheck,
  checkOpenInsertPolicies,
  checkBareAuthUid,
  checkUnindexedOwnerColumn,
  checkNoPolicies
];
function checkView(view) {
  if (view.securityInvoker || !view.anonSelect && !view.authSelect) return [];
  const roles = [view.anonSelect ? "anon" : null, view.authSelect ? "authenticated" : null].filter((role) => role !== null).join(", ");
  const reason = view.materialized ? "Materialized views never respect RLS" : "Without security_invoker this view runs with its owner's rights and ignores the caller's RLS";
  return [
    makeFinding(
      "RR006",
      { schema: view.schema, table: view.view, materialized: view.materialized },
      `${reason}, and ${roles} can select from ${view.schema}.${view.view}.`
    )
  ];
}
function checkDefinerFunction(fn) {
  if (!fn.anonExec && !fn.authExec) return [];
  const callers = fn.anonExec ? "anon" : "authenticated";
  return [
    makeFinding(
      "RR007",
      { schema: fn.schema, functionName: fn.name, functionArgs: fn.args },
      `${fn.schema}.${fn.name}(${fn.args}) runs with its owner's rights, skipping RLS, and ${callers} can call it through the API.`,
      fn.anonExec ? "high" : "medium"
    )
  ];
}
function runStaticRules(introspection) {
  const tableFindings = introspection.tables.flatMap((table) => {
    const policies = introspection.policies.filter(
      (p) => p.schema === table.schema && p.table === table.table
    );
    return TABLE_RULES.flatMap((rule) => rule(table, policies));
  });
  return [
    ...tableFindings,
    ...introspection.views.flatMap(checkView),
    ...introspection.functions.flatMap(checkDefinerFunction)
  ];
}

// src/dynamic.ts
var tableKey = (schema, table) => `${schema}.${table}`;
var rowsOf = (n) => `${n} ${n === 1 ? "row" : "rows"}`;
var COMMAND_FOR_ACTION = {
  select_own: "SELECT",
  select_others: "SELECT",
  select_all: "SELECT",
  insert_other: "INSERT",
  update_other: "UPDATE",
  delete_other: "DELETE",
  update_any: "UPDATE",
  delete_any: "DELETE"
};
function policyNames(table, action, introspection) {
  if (!table.rlsEnabled) return void 0;
  const command = COMMAND_FOR_ACTION[action];
  const names = introspection.policies.filter(
    (p) => p.schema === table.schema && p.table === table.table && (p.cmd === command || p.cmd === "ALL") && grantsApiAccess(p)
  ).map((p) => p.name);
  return names.length === 0 ? void 0 : names.join(", ");
}
function classifyAnonProbe(probe, table, name) {
  const rows = rowsOf(probe.rowCount ?? 0);
  switch (probe.action) {
    case "select_all":
      return table.ownerColumn === void 0 && table.sensitive.length === 0 ? void 0 : { ruleId: "RR101", detail: `Anyone holding the public anon key can read ${rows} of ${name} through the API.` };
    case "update_any":
      return { ruleId: "RR106", detail: `Anyone holding the public anon key can update ${rows} of ${name}.` };
    case "delete_any":
      return { ruleId: "RR106", detail: `Anyone holding the public anon key can delete ${rows} of ${name}.` };
    case "insert_other":
      return { ruleId: "RR106", detail: `Anyone holding the public anon key can insert rows into ${name}.` };
    default:
      return void 0;
  }
}
function classifyUserSelectAll(probe, table, name, total) {
  if (!table.rlsEnabled || table.sensitive.length === 0 || probe.rowCount !== total) return void 0;
  return {
    ruleId: "RR003",
    detail: `Every signed-in user can read all ${rowsOf(probe.rowCount ?? 0)} of ${name}, which has sensitive columns: ${table.sensitive.join(", ")}.`
  };
}
function classifyUserProbe(probe, table, name, total) {
  const rows = rowsOf(probe.rowCount ?? 0);
  switch (probe.action) {
    case "select_others":
      return { ruleId: "RR102", detail: `A signed-in user can read ${rows} of ${name} owned by other users.` };
    case "update_other":
      return { ruleId: "RR103", detail: `A signed-in user can change ${rows} of ${name} owned by other users.` };
    case "delete_other":
      return { ruleId: "RR104", detail: `A signed-in user can delete ${rows} of ${name} owned by other users.` };
    case "insert_other":
      return {
        ruleId: "RR105",
        detail: probe.rowCount === null ? `A signed-in user can create rows in ${name} owned by someone else: RLS let the test row through and only a later constraint rejected it, so a complete row would succeed.` : `A signed-in user can insert a row into ${name} owned by someone else.`
      };
    case "select_all":
      return classifyUserSelectAll(probe, table, name, total);
    default:
      return void 0;
  }
}
function findingsFromProbes(probes, context) {
  return probes.flatMap((probe) => {
    const table = context.introspection.tables.find(
      (t) => t.schema === probe.schema && t.table === probe.table
    );
    if (table === void 0 || probe.outcome !== "allowed") return [];
    const key = tableKey(probe.schema, probe.table);
    const classified = probe.actor === "anon" ? classifyAnonProbe(probe, table, key) : classifyUserProbe(probe, table, key, context.totals.get(key));
    if (classified === void 0) return [];
    const policy = policyNames(table, probe.action, context.introspection);
    return [
      {
        ...makeFinding(
          classified.ruleId,
          {
            schema: table.schema,
            table: table.table,
            ...table.ownerColumn === void 0 ? {} : { column: table.ownerColumn },
            ...policy === void 0 ? {} : { policy }
          },
          classified.detail
        ),
        ...probe.rowCount === null ? {} : { rowsExposed: probe.rowCount },
        probe: { actor: probe.actor, action: probe.action, outcome: probe.outcome, rowCount: probe.rowCount }
      }
    ];
  });
}
var sameTable = (a, b) => a.schema === b.schema && a.table === b.table;
function mergeFindings(staticFindings, dynamicFindings) {
  const openReads = staticFindings.filter((f) => f.ruleId === "RR003");
  const proven = dynamicFindings.filter((f) => f.ruleId !== "RR003" || !openReads.some((s) => sameTable(s, f))).map((finding) => {
    if (finding.ruleId !== "RR102") return finding;
    const causes = openReads.filter((s) => sameTable(s, finding));
    if (causes.length === 0) return finding;
    const policy = causes.flatMap((c) => c.policy === void 0 ? [] : [c.policy]).join(", ");
    return {
      ...finding,
      detail: `${finding.detail} Cause: ${causes.map((c) => c.detail).join(" ")}`,
      ...policy === "" ? {} : { policy }
    };
  });
  const suppressed = dynamicFindings.filter((f) => f.ruleId === "RR102");
  return [
    ...staticFindings.filter(
      (f) => f.ruleId !== "RR003" || !suppressed.some((proof) => sameTable(proof, f))
    ),
    ...proven
  ];
}

// src/introspect.ts
var OWNER_COLUMN_NAMES = [
  "user_id",
  "owner_id",
  "created_by",
  "author_id",
  "profile_id",
  "clinician_id",
  "account_id"
];
var SENSITIVE_NAME_PARTS = [
  "email",
  "phone",
  "dob",
  "birth",
  "ssn",
  "address",
  "diagnosis",
  "note",
  "medical",
  "salary",
  "token",
  "secret",
  "password",
  "card",
  "iban"
];
async function fetchCatalog(sql, schemaNames) {
  const schemas = [...schemaNames];
  const [tables, columns, policies, views, functions, authUserFks, indexes] = await Promise.all([
    sql`
      select n.nspname as schema, c.relname as table, c.oid,
             c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced,
             has_table_privilege('anon', c.oid, 'SELECT')          as anon_select,
             has_table_privilege('anon', c.oid, 'INSERT')          as anon_insert,
             has_table_privilege('anon', c.oid, 'UPDATE')          as anon_update,
             has_table_privilege('anon', c.oid, 'DELETE')          as anon_delete,
             has_table_privilege('authenticated', c.oid, 'SELECT') as auth_select,
             has_table_privilege('authenticated', c.oid, 'INSERT') as auth_insert,
             has_table_privilege('authenticated', c.oid, 'UPDATE') as auth_update,
             has_table_privilege('authenticated', c.oid, 'DELETE') as auth_delete
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r','p') and n.nspname = any(${schemas}::text[])
      order by 1, 2`,
    sql`
      select c.oid as table_oid, a.attnum, a.attname as column, format_type(a.atttypid, a.atttypmod) as type,
             (a.attgenerated = '' and a.attidentity <> 'a') as writable
      from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any(${schemas}::text[]) and c.relkind in ('r','p') and a.attnum > 0 and not a.attisdropped
      order by 1, 2`,
    sql`
      select schemaname as schema, tablename as table, policyname as name, permissive,
             roles::text[] as roles, cmd, qual, with_check
      from pg_policies where schemaname = any(${schemas}::text[])
      order by 1, 2, 3`,
    sql`
      select n.nspname as schema, c.relname as view, c.relkind,
             exists (select 1 from unnest(coalesce(c.reloptions, '{}')) o
                     where o in ('security_invoker=true','security_invoker=on','security_invoker=1')) as security_invoker,
             has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
             has_table_privilege('authenticated', c.oid, 'SELECT') as auth_select
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('v','m') and n.nspname = any(${schemas}::text[])
      order by 1, 2`,
    sql`
      select n.nspname as schema, p.proname as name, pg_get_function_identity_arguments(p.oid) as args,
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.prosecdef and n.nspname = any(${schemas}::text[])
      order by 1, 2, 3`,
    sql`
      select con.conrelid as table_oid, a.attname as column,
             exists (select 1 from pg_constraint pk
                     where pk.conrelid = con.conrelid and pk.contype = 'p'
                       and pk.conkey = array[a.attnum]) as is_sole_pk
      from pg_constraint con
      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any(con.conkey)
      where con.contype = 'f' and con.confrelid = 'auth.users'::regclass`,
    // One query for every leading index column, rather than one round trip per column.
    sql`
      select i.indrelid as table_oid, i.indkey[0] as attnum
      from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any(${schemas}::text[])`
  ]);
  return { tables, columns, policies, views, functions, authUserFks, indexes };
}
function detectOwnerColumn(columns, authUserFks) {
  const fkColumns = new Set(authUserFks.map((fk) => fk.column));
  return authUserFks.find((fk) => fk.is_sole_pk)?.column ?? pickOwnerCandidate(columns.filter((c) => fkColumns.has(c.name))) ?? pickNamedOwner(columns.filter((c) => c.type === "uuid"));
}
function pickNamedOwner(columns) {
  return OWNER_COLUMN_NAMES.find((name) => columns.some((c) => c.name === name));
}
function pickOwnerCandidate(candidates) {
  return pickNamedOwner(candidates) ?? candidates[0]?.name;
}
function findSensitiveColumns(columnNames) {
  return columnNames.filter((name) => {
    const lower = name.toLowerCase();
    return SENSITIVE_NAME_PARTS.some((part) => lower.includes(part));
  });
}
function configuredOwnerColumn(row, columns, ownerColumns) {
  if (!Object.hasOwn(ownerColumns, row.table)) return void 0;
  const configured = ownerColumns[row.table];
  if (!columns.some((c) => c.name === configured)) {
    throw new Error(
      `ownerColumns: ${row.schema}.${row.table} has no column "${configured}". Check redrow.config.json.`
    );
  }
  return configured;
}
function toTableInfo(row, rows, ownerColumns) {
  const indexedAttnums = new Set(
    rows.indexes.filter((i) => i.table_oid === row.oid).map((i) => i.attnum)
  );
  const columns = rows.columns.filter((c) => c.table_oid === row.oid).map((c) => ({
    attnum: c.attnum,
    name: c.column,
    type: c.type,
    indexed: indexedAttnums.has(c.attnum),
    writable: c.writable
  }));
  const fks = rows.authUserFks.filter((fk) => fk.table_oid === row.oid);
  const ownerColumn = configuredOwnerColumn(row, columns, ownerColumns) ?? detectOwnerColumn(columns, fks);
  const anon = {
    select: row.anon_select,
    insert: row.anon_insert,
    update: row.anon_update,
    delete: row.anon_delete
  };
  const authenticated = {
    select: row.auth_select,
    insert: row.auth_insert,
    update: row.auth_update,
    delete: row.auth_delete
  };
  return {
    oid: row.oid,
    schema: row.schema,
    table: row.table,
    rlsEnabled: row.rls_enabled,
    rlsForced: row.rls_forced,
    anon,
    authenticated,
    columns,
    ...ownerColumn === void 0 ? {} : { ownerColumn },
    sensitive: findSensitiveColumns(columns.map((c) => c.name))
  };
}
var toPolicyInfo = (row) => ({
  schema: row.schema,
  table: row.table,
  name: row.name,
  permissive: row.permissive === "PERMISSIVE",
  roles: row.roles,
  cmd: row.cmd,
  qual: row.qual,
  withCheck: row.with_check
});
var toViewInfo = (row) => ({
  schema: row.schema,
  view: row.view,
  materialized: row.relkind === "m",
  securityInvoker: row.security_invoker,
  anonSelect: row.anon_select,
  authSelect: row.auth_select
});
var toFunctionInfo = (row) => ({
  schema: row.schema,
  name: row.name,
  args: row.args,
  anonExec: row.anon_exec,
  authExec: row.auth_exec
});
function buildIntrospection(rows, ownerColumns = {}) {
  return {
    tables: rows.tables.map((row) => toTableInfo(row, rows, ownerColumns)),
    policies: rows.policies.map(toPolicyInfo),
    views: rows.views.map(toViewInfo),
    functions: rows.functions.map(toFunctionInfo)
  };
}
var MISSING_SUPABASE_OBJECT_CODES = /* @__PURE__ */ new Set([
  "42P01",
  // undefined_table
  "3F000",
  // invalid_schema_name
  "42704"
  // undefined_object: a role that does not exist
]);
function hasMissingObjectCode(error) {
  return error instanceof Error && "code" in error && typeof error.code === "string" && MISSING_SUPABASE_OBJECT_CODES.has(error.code);
}
async function introspect(sql, schemas, ownerColumns = {}) {
  try {
    return buildIntrospection(await fetchCatalog(sql, schemas), ownerColumns);
  } catch (error) {
    if (!hasMissingObjectCode(error)) throw error;
    throw new Error(
      `This doesn't look like a Supabase database: ${error.message}. Red Row needs the auth.users table and the anon and authenticated roles.`,
      { cause: error }
    );
  }
}

// src/probes.ts
var INSUFFICIENT_PRIVILEGE = "42501";
var CONSTRAINTS_CHECKED_AFTER_RLS = /* @__PURE__ */ new Set([
  "23502",
  // not_null_violation
  "23503",
  // foreign_key_violation
  "23505",
  // unique_violation
  "23514",
  // check_violation
  "23P01"
  // exclusion_violation
]);
var WORTH_RETRYING = /* @__PURE__ */ new Set([
  "55P03",
  // lock_not_available
  "40P01",
  // deadlock_detected
  "40001"
  // serialization_failure
]);
var RETRIES_AFTER_CONTENTION = 1;
var allowedIfAny = (n) => ({ outcome: n > 0 ? "allowed" : "denied", rowCount: n });
var INCONCLUSIVE = { outcome: "inconclusive", rowCount: null };
var isProbeable = (t) => ![t.schema, t.table, t.ownerColumn ?? ""].some((name) => name.includes("."));
async function measure(run, classify = () => "inconclusive", retries = RETRIES_AFTER_CONTENTION) {
  try {
    return await run();
  } catch (error) {
    const state = sqlStateOf(error);
    if (state === void 0) throw error;
    if (WORTH_RETRYING.has(state) && retries > 0) return measure(run, classify, retries - 1);
    return { outcome: state === INSUFFICIENT_PRIVILEGE ? "denied" : classify(state), rowCount: null };
  }
}
var classifyInsertError = (state) => CONSTRAINTS_CHECKED_AFTER_RLS.has(state) ? "allowed" : "inconclusive";
var firstCount = (rows) => rows[0]?.n ?? 0;
async function countAll(tx, t) {
  return firstCount(await tx`select count(*)::int as n from ${tx(t.schema)}.${tx(t.table)}`);
}
async function countOwnedBy(tx, t, owner, id) {
  return firstCount(
    await tx`select count(*)::int as n from ${tx(t.schema)}.${tx(t.table)} where ${tx(owner)} = ${id}`
  );
}
async function countNotOwnedBy(tx, t, owner, id) {
  return firstCount(
    await tx`select count(*)::int as n from ${tx(t.schema)}.${tx(t.table)} where ${tx(owner)} is distinct from ${id}`
  );
}
function asCaller(sql, role, sub, fn, readOnly = false) {
  return inRolledBackTx(
    sql,
    async (tx) => {
      await impersonate(tx, role, sub);
      return fn(tx);
    },
    { readOnly }
  );
}
function othersAffected(sql, t, owner, userA, mutate) {
  return inRolledBackTx(sql, async (tx) => {
    const before = await countNotOwnedBy(tx, t, owner, userA);
    if (before === 0) return { outcome: "not_applicable", rowCount: 0 };
    await impersonate(tx, "authenticated", userA);
    await mutate(tx);
    await stopImpersonating(tx);
    return allowedIfAny(before - await countNotOwnedBy(tx, t, owner, userA));
  });
}
function insertOwnedBy(sql, t, owner, ownerId, role, sub) {
  return measure(
    () => inRolledBackTx(sql, async (tx) => {
      const before = await countOwnedBy(tx, t, owner, ownerId);
      await impersonate(tx, role, sub);
      await tx`insert into ${tx(t.schema)}.${tx(t.table)} (${tx(owner)}) values (${ownerId})`;
      await stopImpersonating(tx);
      return allowedIfAny(await countOwnedBy(tx, t, owner, ownerId) - before);
    }),
    classifyInsertError
  );
}
function insertDefaults(sql, t) {
  return measure(
    () => asCaller(sql, "anon", void 0, async (tx) => {
      await tx`insert into ${tx(t.schema)}.${tx(t.table)} default values`;
      return { outcome: "allowed", rowCount: 1 };
    }),
    classifyInsertError
  );
}
function anonUpdate(sql, t) {
  const column = t.ownerColumn ?? t.columns.find((c) => c.writable && !c.name.includes("."))?.name;
  if (column === void 0) return Promise.resolve({ outcome: "not_applicable", rowCount: null });
  return measure(
    () => asCaller(sql, "anon", void 0, async (tx) => {
      const result = await tx`update ${tx(t.schema)}.${tx(t.table)} set ${tx(column)} = ${tx(column)}`;
      return allowedIfAny(result.count);
    })
  );
}
function anonProbes(sql, t, actors, readOnly) {
  const reads = [
    {
      actor: "anon",
      action: "select_all",
      run: () => measure(() => asCaller(sql, "anon", void 0, async (tx) => allowedIfAny(await countAll(tx, t)), readOnly))
    }
  ];
  if (readOnly) return reads;
  const owner = t.ownerColumn;
  return [
    ...reads,
    { actor: "anon", action: "update_any", run: () => anonUpdate(sql, t) },
    {
      actor: "anon",
      action: "delete_any",
      run: () => measure(
        () => asCaller(sql, "anon", void 0, async (tx) => {
          const result = await tx`delete from ${tx(t.schema)}.${tx(t.table)}`;
          return allowedIfAny(result.count);
        })
      )
    },
    {
      actor: "anon",
      action: "insert_other",
      run: () => owner === void 0 ? insertDefaults(sql, t) : insertOwnedBy(sql, t, owner, actors.userB, "anon", void 0)
    }
  ];
}
async function updateOthers(sql, t, owner, actors) {
  const qualified = await measure(
    () => asCaller(sql, "authenticated", actors.userA, async (tx) => {
      const result = await tx`update ${tx(t.schema)}.${tx(t.table)} set ${tx(owner)} = ${tx(owner)} where ${tx(owner)} = ${actors.userB}`;
      return allowedIfAny(result.count);
    })
  );
  if (qualified.outcome !== "denied") return qualified;
  return measure(
    () => othersAffected(
      sql,
      t,
      owner,
      actors.userA,
      (tx) => tx`update ${tx(t.schema)}.${tx(t.table)} set ${tx(owner)} = ${actors.userA}`.execute()
    )
  );
}
function ownedTableProbes(sql, t, owner, actors, readOnly) {
  const { userA, userB } = actors;
  const reads = [
    {
      actor: "user_a",
      action: "select_own",
      run: () => measure(
        () => asCaller(
          sql,
          "authenticated",
          userA,
          async (tx) => allowedIfAny(await countOwnedBy(tx, t, owner, userA)),
          readOnly
        )
      )
    },
    {
      actor: "user_a",
      action: "select_others",
      run: () => measure(
        () => asCaller(
          sql,
          "authenticated",
          userA,
          async (tx) => allowedIfAny(await countNotOwnedBy(tx, t, owner, userA)),
          readOnly
        )
      )
    }
  ];
  if (readOnly) return reads;
  return [
    ...reads,
    { actor: "user_a", action: "update_other", run: () => updateOthers(sql, t, owner, actors) },
    {
      actor: "user_a",
      action: "delete_other",
      run: () => measure(
        () => othersAffected(sql, t, owner, userA, (tx) => tx`delete from ${tx(t.schema)}.${tx(t.table)}`.execute())
      )
    },
    {
      actor: "user_a",
      action: "insert_other",
      run: () => insertOwnedBy(sql, t, owner, userB, "authenticated", userA)
    }
  ];
}
function userProbes(sql, t, actors, readOnly) {
  if (t.ownerColumn !== void 0) return ownedTableProbes(sql, t, t.ownerColumn, actors, readOnly);
  return [
    {
      actor: "user_a",
      action: "select_all",
      run: () => measure(
        () => asCaller(sql, "authenticated", actors.userA, async (tx) => allowedIfAny(await countAll(tx, t)), readOnly)
      )
    }
  ];
}
async function runTableProbes(sql, t, actors, settings) {
  const plan = [
    ...settings.anon ? anonProbes(sql, t, actors, settings.readOnly) : [],
    ...settings.authenticated ? userProbes(sql, t, actors, settings.readOnly) : []
  ];
  const results = [];
  for (const probe of plan) {
    const measurement = isProbeable(t) ? await probe.run() : INCONCLUSIVE;
    results.push({ schema: t.schema, table: t.table, actor: probe.actor, action: probe.action, ...measurement });
  }
  return results;
}
async function othersByOwner(sql, t, owner, role, sub, userA, readOnly) {
  try {
    const rows = await asCaller(
      sql,
      role,
      sub,
      (tx) => tx`
        select coalesce(${tx(owner)}::text, '') as owner, count(*)::int as n
        from ${tx(t.schema)}.${tx(t.table)}
        where ${tx(owner)} is distinct from ${userA}
        group by 1`,
      readOnly
    );
    return new Map(rows.map((row) => [row.owner, row.n]));
  } catch (error) {
    if (sqlStateOf(error) === void 0) throw error;
    return void 0;
  }
}
var coversEveryOwner = (seenByUser, seenByAnon) => [...seenByUser].every(([owner, n]) => n <= (seenByAnon.get(owner) ?? 0));
async function seesNoMoreThanAnon(sql, t, actors, readOnly) {
  const owner = t.ownerColumn;
  if (owner === void 0 || !isProbeable(t)) return false;
  const seenByUser = await othersByOwner(sql, t, owner, "authenticated", actors.userA, actors.userA, readOnly);
  const seenByAnon = await othersByOwner(sql, t, owner, "anon", void 0, actors.userA, readOnly);
  return seenByUser !== void 0 && seenByAnon !== void 0 && coversEveryOwner(seenByUser, seenByAnon);
}
async function gatherTableStats(sql, t, readOnly = false) {
  if (!isProbeable(t)) return { total: null, owners: [] };
  const owner = t.ownerColumn;
  try {
    return await inRolledBackTx(
      sql,
      async (tx) => ({
        total: await countAll(tx, t),
        owners: owner === void 0 ? [] : await tx`
              select ${tx(owner)}::text as owner, count(*)::int as n
              from ${tx(t.schema)}.${tx(t.table)}
              where ${tx(owner)} is not null
              group by 1 order by 2 desc limit 2`
      }),
      { readOnly }
    );
  } catch (error) {
    if (sqlStateOf(error) === void 0) throw error;
    return { total: null, owners: [] };
  }
}

// src/score.ts
var SEVERITY_WEIGHTS = {
  critical: 25,
  high: 10,
  medium: 4,
  low: 1,
  info: 0
};
var SEVERITIES = ["critical", "high", "medium", "low", "info"];
var meetsSeverity = (severity, threshold) => SEVERITIES.indexOf(severity) <= SEVERITIES.indexOf(threshold);
var LOW_PENALTY_CAP = 10;
var MAX_SCORE = 100;
var GRADE_THRESHOLDS = [
  [90, "A"],
  [75, "B"],
  [60, "C"],
  [40, "D"]
];
var countOf = (findings, severity) => findings.filter((f) => f.severity === severity).length;
function gradeFor(score, hasCritical) {
  const grade = GRADE_THRESHOLDS.find(([minimum]) => score >= minimum)?.[1] ?? "F";
  return hasCritical && grade !== "F" ? "D" : grade;
}
function scoreFindings(findings) {
  const counts = {
    critical: countOf(findings, "critical"),
    high: countOf(findings, "high"),
    medium: countOf(findings, "medium"),
    low: countOf(findings, "low"),
    info: countOf(findings, "info")
  };
  const penalty = counts.critical * SEVERITY_WEIGHTS.critical + counts.high * SEVERITY_WEIGHTS.high + counts.medium * SEVERITY_WEIGHTS.medium + Math.min(counts.low * SEVERITY_WEIGHTS.low, LOW_PENALTY_CAP);
  const score = Math.max(0, MAX_SCORE - penalty);
  return { score, grade: gradeFor(score, counts.critical > 0), counts };
}

// src/version.ts
var ENGINE_VERSION = "0.1.0";

// src/report.ts
var REPORT_VERSION = 1;
function compareFindings(a, b) {
  return SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.ruleId.localeCompare(b.ruleId) || (a.table ?? "").localeCompare(b.table ?? "");
}
var toReportFinding = (finding) => ({
  id: finding.ruleId,
  severity: finding.severity,
  table: finding.table ?? null,
  policy: finding.policy ?? null,
  probe: finding.probe === void 0 ? null : `${finding.probe.actor}:${finding.probe.action}`,
  description: finding.detail,
  evidence: finding.probe === void 0 ? { kind: "catalog", schema: finding.schema } : { kind: "probe", schema: finding.schema, ...finding.probe },
  remediation: finding.fixHint
});
function toReport(result) {
  return {
    version: REPORT_VERSION,
    scannedAt: result.startedAt,
    database: {
      host: result.target.host,
      name: result.target.database,
      schemas: result.target.schemas
    },
    findings: [...result.findings].sort(compareFindings).map(toReportFinding),
    summary: {
      total: result.findings.filter((f) => f.severity !== "info").length,
      bySeverity: result.counts,
      score: result.score,
      grade: result.grade,
      tablesScanned: result.tables.length,
      probesRun: result.probes.length,
      durationMs: result.durationMs,
      probes: result.probes,
      inconclusive: result.probes.filter((p) => p.outcome === "inconclusive").length,
      warnings: result.warnings
    }
  };
}

// src/rows.ts
var ruleTitle = (id) => RULES[id]?.title ?? id;
var toFindingRow = (finding, projectId) => ({
  project_id: projectId,
  rule_id: finding.id,
  severity: finding.severity,
  schema_name: finding.evidence.schema,
  table_name: finding.table,
  title: ruleTitle(finding.id),
  detail: finding.description,
  rows_exposed: finding.evidence.kind === "probe" ? finding.evidence.rowCount : null,
  fix_hint: finding.remediation
});
function toScanRows(report, projectId, source) {
  const { summary } = report;
  return {
    run: {
      project_id: projectId,
      source,
      engine_version: ENGINE_VERSION,
      score: summary.score,
      grade: summary.grade,
      critical: summary.bySeverity.critical,
      high: summary.bySeverity.high,
      medium: summary.bySeverity.medium,
      low: summary.bySeverity.low,
      tables_scanned: summary.tablesScanned,
      probes_run: summary.probesRun,
      duration_ms: summary.durationMs
    },
    findings: report.findings.map((finding) => toFindingRow(finding, projectId)),
    probes: summary.probes.map((probe) => ({
      project_id: projectId,
      table_name: probe.table,
      actor: probe.actor,
      action: probe.action,
      outcome: probe.outcome,
      row_count: probe.rowCount
    }))
  };
}

// src/index.ts
var DEFAULT_SCHEMAS = ["public"];
var TABLE_CONCURRENCY = 4;
var toTableSummary = (table, totalRows) => ({
  schema: table.schema,
  table: table.table,
  rlsEnabled: table.rlsEnabled,
  ...table.ownerColumn === void 0 ? {} : { ownerColumn: table.ownerColumn },
  totalRows,
  sensitive: table.sensitive
});
function limitToTables(introspection, tables) {
  if (tables === void 0 || tables.length === 0) return introspection;
  const known = new Set(introspection.tables.map((t) => t.table));
  const unknown = tables.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(`No such table in the scanned schemas: ${unknown.join(", ")}`);
  }
  return {
    tables: introspection.tables.filter((t) => tables.includes(t.table)),
    policies: introspection.policies.filter((p) => tables.includes(p.table)),
    views: [],
    functions: []
  };
}
async function connectingRoleWarnings(sql) {
  const rows = await sql`
    select current_user::text as role, (rolsuper or rolbypassrls) as bypass
    from pg_roles where rolname = current_user`;
  const self = rows[0];
  if (self === void 0 || self.bypass) return [];
  return [
    `The connecting role ${self.role} doesn't bypass RLS, so row counts may be low and leaks can be missed. Connect as the postgres role.`
  ];
}
var unprobeableWarnings = (tables) => tables.filter((t) => !isProbeable(t)).map((t) => `Not probed: ${t.schema}.${t.table}. Its name or owner column contains a dot, so only its policies were checked.`);
async function scan(sql, opts = {}) {
  const schemas = opts.schemas ?? DEFAULT_SCHEMAS;
  if (schemas.length === 0) {
    throw new Error("scan: at least one schema is required");
  }
  const startedAtMs = Date.now();
  opts.onPhase?.("introspect");
  const introspection = limitToTables(await introspect(sql, schemas, opts.ownerColumns), opts.tables);
  const staticFindings = runStaticRules(introspection);
  opts.onPhase?.("actors");
  const roleWarnings = await connectingRoleWarnings(sql);
  const stats = await mapConcurrent(
    introspection.tables,
    TABLE_CONCURRENCY,
    (t) => gatherTableStats(sql, t, opts.readOnly ?? false)
  );
  const wantsPin = opts.actors === void 0 && opts.userAEmail !== void 0;
  const pinnedUserA = wantsPin ? await findUserIdByEmail(sql, opts.userAEmail) : void 0;
  const pinWarnings = wantsPin && pinnedUserA === void 0 ? ["The pinned user A was not found in auth.users, so user A was picked automatically."] : [];
  const actors = opts.actors ?? await resolveActors(sql, chooseActors(stats.map((s) => s.owners), pinnedUserA));
  opts.onPhase?.("probes");
  const publicTables = opts.publicTables ?? [];
  const settings = {
    readOnly: opts.readOnly ?? false,
    anon: opts.roles?.anon ?? true,
    authenticated: opts.roles?.authenticated ?? true
  };
  const probes = (await mapConcurrent(introspection.tables, TABLE_CONCURRENCY, (t) => runTableProbes(sql, t, actors, settings))).flat();
  const totalsFor = (index) => stats[index]?.total ?? null;
  const totals = new Map(
    introspection.tables.map((t, index) => [tableKey(t.schema, t.table), totalsFor(index)])
  );
  const merged = mergeFindings(staticFindings, findingsFromProbes(probes, { introspection, totals }));
  const toCompare = introspection.tables.filter(
    (t) => settings.anon && isDeclared(t, publicTables) && merged.some((f) => f.ruleId === "RR102" && f.schema === t.schema && f.table === t.table)
  );
  const compared = await mapConcurrent(toCompare, TABLE_CONCURRENCY, async (t) => ({
    table: t,
    noWider: await seesNoMoreThanAnon(sql, t, actors, settings.readOnly)
  }));
  const noWiderThanAnon = new Set(
    compared.filter((c) => c.noWider).map((c) => tableKey(c.table.schema, c.table.table))
  );
  const findings = applyDeclaredExposure(merged, introspection, publicTables, noWiderThanAnon);
  return {
    engineVersion: ENGINE_VERSION,
    startedAt: new Date(startedAtMs).toISOString(),
    durationMs: Date.now() - startedAtMs,
    // Only the host and database name: the driver's parsed options also hold the password.
    target: {
      host: sql.options.host.join(","),
      database: sql.options.database ?? "",
      schemas: [...schemas]
    },
    ...scoreFindings(findings),
    tables: introspection.tables.map((t, index) => toTableSummary(t, totalsFor(index))),
    findings,
    probes,
    actors,
    warnings: [...roleWarnings, ...pinWarnings, ...unprobeableWarnings(introspection.tables)]
  };
}
export {
  ENGINE_VERSION,
  ImpersonationError,
  REPORT_VERSION,
  RULES,
  SEVERITIES,
  TxSetupError,
  applyDeclaredExposure,
  buildIntrospection,
  detectOwnerColumn,
  findSensitiveColumns,
  findingsFromProbes,
  gatherTableStats,
  grantsApiAccess,
  impersonate,
  inRolledBackTx,
  introspect,
  makeFinding,
  meetsSeverity,
  mergeFindings,
  quoteIdent,
  runStaticRules,
  runTableProbes,
  scan,
  scoreFindings,
  stopImpersonating,
  toReport,
  toScanRows,
  usesBareAuthUid,
  wrapBareAuthUid
};
