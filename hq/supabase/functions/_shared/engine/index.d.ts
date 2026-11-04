import { ISql, Sql, TransactionSql } from 'postgres';

/** Names a fix hint can refer to. Hints fall back to placeholders for anything absent. */
interface FixHintContext {
    readonly schema: string;
    readonly table?: string;
    readonly column?: string;
    readonly policy?: string;
    /** RR006: a materialized view can't take `security_invoker`, so its fix differs. */
    readonly materialized?: boolean;
    /** RR007: the function's name and identity arguments. */
    readonly functionName?: string;
    readonly functionArgs?: string;
}
interface RuleDefinition {
    readonly severity: Severity;
    readonly title: string;
    readonly fixHint: (context: FixHintContext) => string;
}
declare const quoteIdent: (name: string) => string;
declare const RULES: {
    readonly RR001: {
        readonly severity: "critical";
        readonly title: "RLS disabled: table is publicly readable through the API";
        readonly fixHint: (c: FixHintContext) => string;
    };
    readonly RR002: {
        readonly severity: "high";
        readonly title: "RLS disabled on a table API roles can access";
        readonly fixHint: (c: FixHintContext) => string;
    };
    readonly RR003: {
        readonly severity: "high";
        readonly title: "Read policy matches every row (USING true)";
        readonly fixHint: (c: FixHintContext) => string;
    };
    readonly RR004: {
        readonly severity: "medium";
        readonly title: "UPDATE policy has no explicit WITH CHECK";
        readonly fixHint: (c: FixHintContext) => string;
    };
    readonly RR005: {
        readonly severity: "medium";
        readonly title: "INSERT policy does not check row ownership";
        readonly fixHint: (c: FixHintContext) => string;
    };
    readonly RR006: {
        readonly severity: "high";
        readonly title: "View bypasses RLS";
        readonly fixHint: (c: FixHintContext) => string;
    };
    readonly RR007: {
        readonly severity: "high";
        readonly title: "SECURITY DEFINER function callable from the API";
        readonly fixHint: (c: FixHintContext) => string;
    };
    readonly RR008: {
        readonly severity: "low";
        readonly title: "Policy re-evaluates auth.uid() for every row";
        readonly fixHint: (c: FixHintContext) => string;
    };
    readonly RR009: {
        readonly severity: "low";
        readonly title: "Owner column used in a policy has no index";
        readonly fixHint: (c: FixHintContext) => string;
    };
    readonly RR010: {
        readonly severity: "medium";
        readonly title: "RLS enabled with no policies, so API roles see nothing";
        readonly fixHint: (c: FixHintContext) => string;
    };
    readonly RR101: {
        readonly severity: "critical";
        readonly title: "Anonymous users can read an owned or sensitive table";
        readonly fixHint: (c: FixHintContext) => string;
    };
    readonly RR102: {
        readonly severity: "critical";
        readonly title: "A signed-in user can read other users' rows";
        readonly fixHint: (c: FixHintContext) => string;
    };
    readonly RR103: {
        readonly severity: "critical";
        readonly title: "A signed-in user can update other users' rows";
        readonly fixHint: (c: FixHintContext) => string;
    };
    readonly RR104: {
        readonly severity: "critical";
        readonly title: "A signed-in user can delete other users' rows";
        readonly fixHint: (c: FixHintContext) => string;
    };
    readonly RR105: {
        readonly severity: "high";
        readonly title: "A signed-in user can insert a row owned by someone else";
        readonly fixHint: (c: FixHintContext) => string;
    };
    readonly RR106: {
        readonly severity: "high";
        readonly title: "Anonymous users can write to a table";
        readonly fixHint: (c: FixHintContext) => string;
    };
};
type RuleId = keyof typeof RULES;
/** Builds a finding from the catalog. `severity` overrides the default where a rule has two levels. */
declare function makeFinding(ruleId: RuleId, context: FixHintContext, detail: string, severity?: Severity): Finding;

/** `info` is declared exposure: reported, but it scores nothing and never fails a scan. */
type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
type Grade = 'A' | 'B' | 'C' | 'D' | 'F';
type SeverityCounts = Readonly<Record<Severity, number>>;
interface Finding {
    readonly ruleId: RuleId;
    readonly severity: Severity;
    readonly schema: string;
    /** Table or view the finding is about. Absent for schema-level objects such as functions. */
    readonly table?: string;
    readonly title: string;
    readonly detail: string;
    readonly rowsExposed?: number;
    readonly fixHint: string;
    /** The policy or policies behind the finding, where they can be named. */
    readonly policy?: string;
    /** The probe that proved it. Absent when the finding comes from the catalog alone. */
    readonly probe?: ProbeEvidence;
}
type ProbeActor = 'anon' | 'user_a' | 'user_b';
type ProbeAction = 'select_own' | 'select_others' | 'select_all' | 'insert_other' | 'update_other' | 'delete_other' | 'update_any' | 'delete_any';
type ProbeOutcome = 'allowed' | 'denied' | 'inconclusive' | 'not_applicable';
/** What a probe measured. Counts only, never row contents. */
interface ProbeEvidence {
    readonly actor: ProbeActor;
    readonly action: ProbeAction;
    readonly outcome: ProbeOutcome;
    readonly rowCount: number | null;
}
interface ProbeResult extends ProbeEvidence {
    readonly schema: string;
    readonly table: string;
}
interface TableSummary {
    readonly schema: string;
    readonly table: string;
    readonly rlsEnabled: boolean;
    readonly ownerColumn?: string;
    /** Null when the count itself hit the statement timeout. */
    readonly totalRows: number | null;
    readonly sensitive: readonly string[];
}
interface Actors {
    readonly userA: string;
    readonly userB: string;
}
type ScanPhase = 'introspect' | 'actors' | 'probes';
/** The JSON report, and what `--upload` sends. ENGINE.md §5. */
interface ScanResult {
    readonly engineVersion: string;
    readonly startedAt: string;
    readonly durationMs: number;
    readonly target: {
        readonly host: string;
        readonly database: string;
        readonly schemas: readonly string[];
    };
    readonly score: number;
    readonly grade: Grade;
    readonly counts: SeverityCounts;
    readonly tables: readonly TableSummary[];
    readonly findings: readonly Finding[];
    readonly probes: readonly ProbeResult[];
    /** Uuids only. */
    readonly actors: Actors;
    /** Reasons this result may understate the leaks. */
    readonly warnings: readonly string[];
}
interface ScanOptions {
    /** Defaults to `['public']`. */
    readonly schemas?: readonly string[];
    /** Skips every write probe. */
    readonly readOnly?: boolean;
    /** Table name to owner column, from `redrow.config.json`. Wins over detection. */
    readonly ownerColumns?: Readonly<Record<string, string>>;
    /** Limit the scan to these tables. Views and functions aren't tables, so they are left out too. */
    readonly tables?: readonly string[];
    /** Use these two users instead of picking them from the data. */
    readonly actors?: Actors;
    /** Pin user A to this auth.users email, looked up for its id. If it isn't found, the pick is automatic and a warning says so. */
    readonly userAEmail?: string;
    /** Tables anon is meant to read: a bare name means the public schema, or use `schema.table`. Covers anon reads only. */
    readonly publicTables?: readonly string[];
    /** Skip every probe for a role. Both default to true. */
    readonly roles?: {
        readonly anon?: boolean;
        readonly authenticated?: boolean;
    };
    readonly onPhase?: (phase: ScanPhase) => void;
}
interface TablePrivileges {
    readonly select: boolean;
    readonly insert: boolean;
    readonly update: boolean;
    readonly delete: boolean;
}
interface ColumnInfo {
    readonly attnum: number;
    readonly name: string;
    readonly type: string;
    /** True when the column leads at least one index. */
    readonly indexed: boolean;
    /** False for generated and `generated always` identity columns, which can't be assigned to. */
    readonly writable: boolean;
}
interface TableInfo {
    readonly oid: number;
    readonly schema: string;
    readonly table: string;
    readonly rlsEnabled: boolean;
    readonly rlsForced: boolean;
    readonly anon: TablePrivileges;
    readonly authenticated: TablePrivileges;
    readonly columns: readonly ColumnInfo[];
    readonly ownerColumn?: string;
    readonly sensitive: readonly string[];
}
type PolicyCommand = 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
interface PolicyInfo {
    readonly schema: string;
    readonly table: string;
    readonly name: string;
    readonly permissive: boolean;
    readonly roles: readonly string[];
    readonly cmd: PolicyCommand;
    /** USING expression, as normalized by `pg_policies`. */
    readonly qual: string | null;
    /** WITH CHECK expression, as normalized by `pg_policies`. */
    readonly withCheck: string | null;
}
interface ViewInfo {
    readonly schema: string;
    readonly view: string;
    readonly materialized: boolean;
    readonly securityInvoker: boolean;
    readonly anonSelect: boolean;
    readonly authSelect: boolean;
}
interface SecurityDefinerFunction {
    readonly schema: string;
    readonly name: string;
    readonly args: string;
    readonly anonExec: boolean;
    readonly authExec: boolean;
}
interface Introspection {
    readonly tables: readonly TableInfo[];
    readonly policies: readonly PolicyInfo[];
    readonly views: readonly ViewInfo[];
    readonly functions: readonly SecurityDefinerFunction[];
}

declare const ENGINE_VERSION = "0.1.0";

interface TableRow {
    readonly schema: string;
    readonly table: string;
    readonly oid: number;
    readonly rls_enabled: boolean;
    readonly rls_forced: boolean;
    readonly anon_select: boolean;
    readonly anon_insert: boolean;
    readonly anon_update: boolean;
    readonly anon_delete: boolean;
    readonly auth_select: boolean;
    readonly auth_insert: boolean;
    readonly auth_update: boolean;
    readonly auth_delete: boolean;
}
interface ColumnRow {
    readonly table_oid: number;
    readonly attnum: number;
    readonly column: string;
    readonly type: string;
    readonly writable: boolean;
}
interface PolicyRow {
    readonly schema: string;
    readonly table: string;
    readonly name: string;
    readonly permissive: string;
    readonly roles: readonly string[];
    readonly cmd: PolicyCommand;
    readonly qual: string | null;
    readonly with_check: string | null;
}
interface ViewRow {
    readonly schema: string;
    readonly view: string;
    readonly relkind: string;
    readonly security_invoker: boolean;
    readonly anon_select: boolean;
    readonly auth_select: boolean;
}
interface FunctionRow {
    readonly schema: string;
    readonly name: string;
    readonly args: string;
    readonly anon_exec: boolean;
    readonly auth_exec: boolean;
}
interface AuthUserFkRow {
    readonly table_oid: number;
    readonly column: string;
    /** The column is the table's whole primary key, as with `profiles.id`. */
    readonly is_sole_pk: boolean;
}
interface IndexRow {
    readonly table_oid: number;
    readonly attnum: number;
}
interface CatalogRows {
    readonly tables: readonly TableRow[];
    readonly columns: readonly ColumnRow[];
    readonly policies: readonly PolicyRow[];
    readonly views: readonly ViewRow[];
    readonly functions: readonly FunctionRow[];
    readonly authUserFks: readonly AuthUserFkRow[];
    readonly indexes: readonly IndexRow[];
}
/**
 * Owner detection, after config: FK to auth.users, then name heuristic. A primary key
 * that is itself such an FK wins among FKs: the table is 1:1 with users (`profiles.id`),
 * so another column such as `created_by` can't be the owner.
 */
declare function detectOwnerColumn(columns: readonly ColumnInfo[], authUserFks: readonly AuthUserFkRow[]): string | undefined;
declare function findSensitiveColumns(columnNames: readonly string[]): string[];
/** Turns raw catalog rows into the domain model. Pure, so it can be tested without a database. */
declare function buildIntrospection(rows: CatalogRows, ownerColumns?: Readonly<Record<string, string>>): Introspection;
declare function introspect(sql: ISql, schemas: readonly string[], ownerColumns?: Readonly<Record<string, string>>): Promise<Introspection>;

/**
 * Tables the project means to expose, listed in `publicTables` by name or `schema.table`.
 * Anon reading one is reported at `info`, which scores nothing. It stays in the report, so
 * the exposure is declared rather than hidden. RR102 goes away on a table in
 * `noWiderThanAnon`, keyed by `schema.table`, where a signed-in user sees nothing beyond
 * what RR101 already reports. A table anyone can write to gets no such treatment, even
 * for its reads.
 */
declare function applyDeclaredExposure(findings: readonly Finding[], introspection: Introspection, publicTables: readonly string[], noWiderThanAnon?: ReadonlySet<string>): Finding[];

interface ProbeContext {
    readonly introspection: Introspection;
    /** Row totals, keyed by `schema.table`. */
    readonly totals: ReadonlyMap<string, number | null>;
}
/** RR101-RR106, plus RR003's evidence on un-owned tables. Pure, so testable without a database. */
declare function findingsFromProbes(probes: readonly ProbeResult[], context: ProbeContext): Finding[];
/**
 * Dynamic proof wins (ENGINE.md §2): RR102 replaces a static RR003 on the same table
 * and keeps its text as the explanation. A dynamic RR003 adds nothing to a static one.
 */
declare function mergeFindings(staticFindings: readonly Finding[], dynamicFindings: readonly Finding[]): Finding[];

interface OwnerCount {
    readonly owner: string;
    readonly n: number;
}

interface ProbeSettings {
    readonly readOnly: boolean;
    readonly anon: boolean;
    readonly authenticated: boolean;
}
interface TableStats {
    readonly total: number | null;
    readonly owners: readonly OwnerCount[];
}
/**
 * Every probe gets its own transaction, and so its own rollback, and they run one at a
 * time per table so that one probe's row locks can't trip the next one's lock timeout.
 */
declare function runTableProbes(sql: Sql, t: TableInfo, actors: Actors, settings: ProbeSettings): Promise<ProbeResult[]>;
/** Row total and top owners, as the connecting role. Counts and owner ids only. */
declare function gatherTableStats(sql: Sql, t: TableInfo, readOnly?: boolean): Promise<TableStats>;

/**
 * The public JSON contract that `redrow scan --json` emits and H5/H6 consume.
 * Bump this for any breaking change.
 */
declare const REPORT_VERSION = 1;
type ReportEvidence = ({
    readonly kind: 'probe';
    readonly schema: string;
} & ProbeEvidence) | {
    readonly kind: 'catalog';
    readonly schema: string;
};
interface ReportFinding {
    /** Rule id, such as `RR102`. */
    readonly id: string;
    readonly severity: Severity;
    readonly table: string | null;
    readonly policy: string | null;
    /** `actor:action`, such as `user_a:select_others`. Null for catalog findings. */
    readonly probe: string | null;
    /** What a caller could actually do. */
    readonly description: string;
    readonly evidence: ReportEvidence;
    readonly remediation: string;
}
interface ReportSummary {
    /** Findings that count against the score. Declared exposure is only in `bySeverity.info`. */
    readonly total: number;
    readonly bySeverity: SeverityCounts;
    readonly score: number;
    readonly grade: Grade;
    readonly tablesScanned: number;
    readonly probesRun: number;
    readonly durationMs: number;
    /** Every probe that ran, including denied ones: the leak matrix. Counts only. */
    readonly probes: readonly ProbeResult[];
    /** Probes that proved nothing either way, so "no findings" doesn't cover them. */
    readonly inconclusive: number;
    /** Reasons this report may understate the leaks. */
    readonly warnings: readonly string[];
}
interface Report {
    readonly version: number;
    readonly scannedAt: string;
    /** No credentials or user names, ever. */
    readonly database: {
        readonly host: string;
        readonly name: string;
        readonly schemas: readonly string[];
    };
    readonly findings: readonly ReportFinding[];
    readonly summary: ReportSummary;
}
/** Actor ids stay out on purpose: they are real user ids, and the report may be shared. */
declare function toReport(result: ScanResult): Report;

/** `seed` marks backfilled history, so nothing can mistake it for a real scan. */
type ScanSource = 'cli' | 'sweep' | 'ci' | 'dashboard' | 'seed';
interface ScanRunRow {
    readonly project_id: string;
    readonly source: ScanSource;
    readonly engine_version: string;
    readonly score: number;
    readonly grade: string;
    readonly critical: number;
    readonly high: number;
    readonly medium: number;
    readonly low: number;
    readonly tables_scanned: number;
    readonly probes_run: number;
    readonly duration_ms: number;
}
interface FindingRow {
    readonly project_id: string;
    readonly rule_id: string;
    readonly severity: Severity;
    readonly schema_name: string;
    readonly table_name: string | null;
    readonly title: string;
    readonly detail: string;
    readonly rows_exposed: number | null;
    readonly fix_hint: string;
}
interface ProbeRow {
    readonly project_id: string;
    readonly table_name: string;
    readonly actor: ProbeActor;
    readonly action: ProbeAction;
    readonly outcome: ProbeOutcome;
    readonly row_count: number | null;
}
interface ScanRows {
    readonly run: ScanRunRow;
    readonly findings: readonly FindingRow[];
    readonly probes: readonly ProbeRow[];
}
/** A report as HQ's insert-only tables hold it. Counts and catalog text only, as in the report. */
declare function toScanRows(report: Report, projectId: string, source: ScanSource): ScanRows;

/** Most severe first. */
declare const SEVERITIES: readonly Severity[];
/** True when `severity` is at least as serious as `threshold`. */
declare const meetsSeverity: (severity: Severity, threshold: Severity) => boolean;
interface ScoreSummary {
    readonly score: number;
    readonly grade: Grade;
    readonly counts: SeverityCounts;
}
/** ENGINE.md §4. */
declare function scoreFindings(findings: readonly Finding[]): ScoreSummary;

/** Only a permissive policy can widen access; a restrictive one can only narrow it. */
declare const grantsApiAccess: (policy: PolicyInfo) => boolean;
/** True when an expression calls `auth.uid()` outside a `(select ...)`, so it runs once per row. */
declare function usesBareAuthUid(expression: string): boolean;
/** Rewrites each bare `auth.uid()` to the wrapped form, leaving ones already wrapped alone. */
declare function wrapBareAuthUid(expression: string): string;
/** RR001-RR010, as pure functions over the introspection result. */
declare function runStaticRules(introspection: Introspection): Finding[];

type ProbeRole = 'anon' | 'authenticated';
/**
 * The connecting role can't become an API role. This must fail the scan: read as a denied
 * probe, it would make every table look safe. It has no `code`, so nothing treats it as a
 * server response to a probe.
 */
declare class ImpersonationError extends Error {
}
/**
 * The transaction never got as far as running a probe: the login failed, or the pooler
 * refused. It keeps the server's `code` for the CLI's messages, but it is not an answer
 * from any policy, even when the code looks like one.
 */
declare class TxSetupError extends Error {
    readonly code: string;
    constructor(message: string, code: string);
}
interface TxOptions {
    /** Have the database itself refuse writes, not just skip sending them. */
    readonly readOnly?: boolean;
}
/**
 * Runs `fn` in a transaction that always ends in ROLLBACK: throwing is the only way
 * out of the callback, so no path through here can commit. `sql.begin` holds one
 * connection for the transaction and releases it on success and on failure.
 *
 * Repeatable read keeps before and after counts comparable: another session's commit
 * can't shift them, while this transaction still sees its own writes.
 */
declare function inRolledBackTx<T>(sql: Sql, fn: (tx: TransactionSql) => Promise<T>, { readOnly }?: TxOptions): Promise<T>;
/**
 * Become an API caller for the rest of the transaction. Everything here is
 * transaction-local: `set_config(..., true)` is the parameterized form of SET LOCAL.
 * Both claim forms are set because `auth.uid()` reads either, depending on its version.
 */
declare function impersonate(tx: TransactionSql, role: ProbeRole, sub?: string): Promise<void>;
/** Back to the connecting role, to measure a probe's effect within the same transaction. */
declare function stopImpersonating(tx: TransactionSql): Promise<void>;

/** Introspect, apply static rules, pick actors, probe, score. Every probe is rolled back. */
declare function scan(sql: Sql, opts?: ScanOptions): Promise<ScanResult>;

export { ENGINE_VERSION, ImpersonationError, REPORT_VERSION, RULES, SEVERITIES, TxSetupError, applyDeclaredExposure, buildIntrospection, detectOwnerColumn, findSensitiveColumns, findingsFromProbes, gatherTableStats, grantsApiAccess, impersonate, inRolledBackTx, introspect, makeFinding, meetsSeverity, mergeFindings, quoteIdent, runStaticRules, runTableProbes, scan, scoreFindings, stopImpersonating, toReport, toScanRows, usesBareAuthUid, wrapBareAuthUid };
export type { Actors, ColumnInfo, Finding, FindingRow, FixHintContext, Grade, Introspection, PolicyCommand, PolicyInfo, ProbeAction, ProbeActor, ProbeEvidence, ProbeOutcome, ProbeResult, ProbeRole, ProbeRow, Report, ReportEvidence, ReportFinding, ReportSummary, RuleDefinition, RuleId, ScanOptions, ScanPhase, ScanResult, ScanRows, ScanRunRow, ScanSource, ScoreSummary, SecurityDefinerFunction, Severity, SeverityCounts, TableInfo, TablePrivileges, TableSummary, ViewInfo };
