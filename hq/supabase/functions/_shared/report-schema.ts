import { z } from 'zod'

// Anyone holding the key can post here, and these strings end up on a public page, so
// everything has a limit. The database's check constraints are the second line of defence.
const MAX_FINDINGS = 2000
const MAX_PROBES = 20000
const SMALLINT_MAX = 32767
const INT_MAX = 2147483647

const shortText = z.string().max(256)
const longText = z.string().max(8000)
const count = z.number().int().min(0).max(SMALLINT_MAX)
const rowCount = z.number().int().min(0).max(INT_MAX).nullable()

const actor = z.enum(['anon', 'user_a', 'user_b'])
const action = z.enum([
  'select_own',
  'select_others',
  'select_all',
  'insert_other',
  'update_other',
  'delete_other',
  'update_any',
  'delete_any',
])
const outcome = z.enum(['allowed', 'denied', 'inconclusive', 'not_applicable'])

const evidence = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('catalog'), schema: shortText }),
  z.object({ kind: z.literal('probe'), schema: shortText, actor, action, outcome, rowCount }),
])

const finding = z.object({
  id: z.string().regex(/^RR[0-9]{3}$/),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  table: shortText.nullable(),
  policy: shortText.nullable(),
  probe: shortText.nullable(),
  description: longText,
  evidence,
  remediation: longText,
})

const probe = z.object({ schema: shortText, table: shortText, actor, action, outcome, rowCount })

const report = z.object({
  version: z.literal(1),
  scannedAt: shortText,
  database: z.object({ host: shortText, name: shortText, schemas: z.array(shortText).max(50) }),
  findings: z.array(finding).max(MAX_FINDINGS),
  summary: z.object({
    total: count,
    bySeverity: z.object({ critical: count, high: count, medium: count, low: count, info: count }),
    score: z.number().int().min(0).max(100),
    grade: z.enum(['A', 'B', 'C', 'D', 'F']),
    tablesScanned: count,
    probesRun: z.number().int().min(0).max(INT_MAX),
    durationMs: z.number().int().min(0).max(INT_MAX),
    probes: z.array(probe).max(MAX_PROBES),
    inconclusive: z.number().int().min(0).max(INT_MAX),
    warnings: z.array(longText).max(1000),
  }),
})

export const ingestBody = z.object({ project: z.string().min(1).max(80), report })
export type IngestBody = z.infer<typeof ingestBody>

/** Refused before parsing: a Report for even a very large schema is well under this. */
export const MAX_BODY_BYTES = 5 * 1024 * 1024
