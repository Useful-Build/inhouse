// Stage 1 M3 (frozen by M3-A, N26; M3-C builds the routes and the screen): the Inhouse ceiling, per write operation,
// as the "What the agent can do" page reads and the Inhouse team sets it. `GET /api/ceiling`: the Inhouse team and
// admins (members 403). `PUT /api/ceiling/:operation`: the Inhouse team only, refused `writes_off` while editing is off
// in a deployable build (`CEILING_EDIT_ON = false`, N2). Every word a person reads here is the server's own.
import { z } from 'zod'
import { InstantSchema } from './common.ts'
import { BATCH_ITEMS_MAX, ActionApproverKindSchema } from './actions.ts'
import { GuardrailSchema, RowIfRevSchema } from './permissions.ts'

/** The most records one call may touch before it needs an exact approval (`bulk`): the ceiling's `bulk_threshold` is 1 to this. */
export const BULK_THRESHOLD_MAX = 5

/**
 * The largest limit or unit count anywhere in M3 (a ceiling value, a grant's count, one action's units): refund units are
 * the shop's minor currency units, so the top is wide. The audit lines use the same bound.
 */
export const LIMIT_MAX = 1_000_000_000
const LimitSchema = z.number().int().min(1).max(LIMIT_MAX)

/**
 * What an operation's units are: a count of things in the person's words ("orders", "stock units", "posts"), or money in
 * the shop's minor currency units (`currency` is the shop's ISO 4217 code; null while no connected account names one).
 * A money limit is shown as money in that currency, never as a count.
 */
export const CeilingMeasureSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('count'), label: z.string() }),
  z.object({ kind: z.literal('money'), currency: z.string().regex(/^[A-Z]{3}$/).nullable() }),
])
export type CeilingMeasure = z.infer<typeof CeilingMeasureSchema>

/**
 * One operation's ceiling (`permission_ceiling`, 0720 and 0760). `perDayMax`: the most units any one permission may use
 * in a brand day. `unitsMax`: the largest single call (one item), whatever approves it. `bulkThreshold`: more records
 * than this in one call is an exact approval. `batchMax`: the most items one batch card holds.
 */
export const CeilingValuesSchema = z.object({
  enabled: z.boolean(),
  perDayMax: LimitSchema,
  unitsMax: LimitSchema,
  bulkThreshold: z.number().int().min(1).max(BULK_THRESHOLD_MAX),
  batchMax: z.number().int().min(1).max(BATCH_ITEMS_MAX),
}).strict()
export type CeilingValues = z.infer<typeof CeilingValuesSchema>

/**
 * One operation as the page lists it: every operation in the server's table, with its row or, when it has none yet, off
 * with the suggested values (`rev`, `updatedAt` and `updatedBy` null). `operation` is the server's key, opaque to the
 * client. `guardrails`: the ones its effects always apply (`money`, `customer`, `destructive`, `access`); `bulk` and
 * `count` depend on the call and are said through `bulkThreshold` and the limits. `approverKind`: `admins` for an
 * operation a member may not approve (N25).
 */
export const CeilingRowSchema = CeilingValuesSchema.extend({
  operation: z.string(),
  /** What it does, in plain words: "Add tags to orders". */
  title: z.string(),
  /** A sentence more, in plain words, for the technical page. */
  description: z.string(),
  /** The tool it writes to: "Shopify", "Slack". */
  tool: z.string(),
  /** What its limits count. */
  measure: CeilingMeasureSchema,
  /**
   * Which values mean something for it: `perDay` only where a grant can cover it (no effect flag; an exact-only
   * operation has no daily count), `batch` (`bulkThreshold` and `batchMax`) only where its calls can become a batch.
   * The screen says nothing about a value that doesn't apply; the row still holds it.
   */
  applies: z.object({ perDay: z.boolean(), batch: z.boolean() }),
  guardrails: z.array(GuardrailSchema),
  approverKind: ActionApproverKindSchema,
  /** The values N24 suggests for a new row (the operation's entry). */
  suggested: z.object({ perDayMax: LimitSchema, unitsMax: LimitSchema }),
  /** `permission_ceiling.rev`: the `ifRev` for the next change; null while the operation has no row. */
  rev: z.number().int().min(1).nullable(),
  updatedAt: InstantSchema.nullable(),
  /** Who made the last change (a member id, or the test build's actor); null while the operation has no row. */
  updatedBy: z.string().nullable(),
})
export type CeilingRow = z.infer<typeof CeilingRowSchema>

/**
 * `GET /api/ceiling`. `can.edit`: this viewer may change it now (the Inhouse team, with editing on); display only, the
 * PUT checks again. `writesOff`: editing is off in this build (a deployable build until M3-J flips it).
 */
export const CeilingListSchema = z.object({
  items: z.array(CeilingRowSchema),
  can: z.object({ edit: z.boolean() }),
  writesOff: z.boolean(),
})
export type CeilingList = z.infer<typeof CeilingListSchema>

/**
 * `PUT /api/ceiling/:operation`: the whole row's new values. `ifRev`: the row's `rev` last read, or null to create a row
 * that doesn't exist yet (refused as a conflict when one does). Lowering any value raises `lowered_rev` (N23). Answers
 * with the operation's row as it now is.
 */
export const UpdateCeilingInputSchema = CeilingValuesSchema.extend({ ifRev: RowIfRevSchema.nullable() }).strict()
export type UpdateCeilingInput = z.infer<typeof UpdateCeilingInputSchema>
