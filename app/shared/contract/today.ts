// Today's contracts (p4-w3.md sections 2 and 5): what the morning check's run returns, what Today stores and serves, the
// reduced wire schema the SDK is given, and the two routes' shapes. The model returns `MorningCheckResult` (checked in
// full by zod on the server); Today never parses prose.
import { z } from 'zod'
import { SetAsideReasonSchema } from './state.ts'
import { InstantSchema, MoneySchema } from './common.ts'
import { ProblemSchema } from './problem.ts'

/** The sample data's severity and area values (src/agent/sample-data/problems.json): the only values a card draws. */
export const SEVERITIES = ['#b97a14', '#b23c22'] as const
export const AREAS = ['Orders', 'Stock', 'Money'] as const
/** The store's areas a read can fail on (what `gaps` names). */
export const GAP_AREAS = ['orders', 'products', 'inventory', 'refunds', 'returns'] as const
/** The server-only gap: more than 10 items came back and 10 are shown. Never in the wire schema. */
export const TOO_MANY = 'too_many'
export const ITEMS_MAX = 10

export const MorningCheckItemSchema = z.strictObject({
  key: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+){0,5}$/).max(48),
  sev: z.enum(SEVERITIES),
  area: z.enum(AREAS),
  title: z.string().min(1).max(120),
  sub: z.string().max(200),
  cost: MoneySchema.nullable(),
  costNote: z.string().max(100),
  next: z.string().min(1).max(140),
  found: z.array(z.array(z.string().max(160)).length(2)).max(6),
  sources: z.array(z.strictObject({ n: z.string().min(1).max(40), text: z.string().max(160) })).max(10),
  since: z.string().max(40).nullable(),
})
export type MorningCheckItem = z.infer<typeof MorningCheckItemSchema>

export const MorningCheckResultSchema = z.strictObject({
  coverage: z.enum(['complete', 'incomplete']),
  gaps: z.array(z.enum(GAP_AREAS)).max(5),
  items: z.array(MorningCheckItemSchema).max(ITEMS_MAX),
})
export type MorningCheckResult = z.infer<typeof MorningCheckResultSchema>

/** What Today stores and serves: instants as { iso, ms } (C1), built by the server, never by the model. */
export const TodayItemSchema = MorningCheckItemSchema.omit({ since: true }).extend({
  id: z.string(), since: InstantSchema.nullable(), foundAt: InstantSchema, routineRun: z.string(),
})
export type TodayItem = z.infer<typeof TodayItemSchema>

/** A set-aside record as Today serves it: `reason` null is an Undo (the row stays, so its `rev` guards the next write). */
export const TodayAsideSchema = z.strictObject({
  reason: SetAsideReasonSchema.nullable(),
  at: InstantSchema,
  by: z.string(),
  loggedAt: InstantSchema,
  rev: z.number().int().min(1),
})
export type TodayAside = z.infer<typeof TodayAsideSchema>

/** Route 57 `GET /api/today`: the cards to show (set aside ones left out) and the records for every card of the shown run. */
export const TodayAnswerSchema = z.strictObject({
  items: z.array(ProblemSchema),
  aside: z.record(z.string(), TodayAsideSchema),
})
export type TodayAnswer = z.infer<typeof TodayAnswerSchema>

/** Route 58 `PUT /api/today/:id/aside`: `declined` is P6's, so Today takes only a snooze, a dismissal or an Undo (null). */
export const SetAsideBodySchema = z.strictObject({
  reason: z.enum(['snoozed', 'dismissed']).nullable(),
  ifRev: z.number().int().min(0),
})
export type SetAsideBody = z.infer<typeof SetAsideBodySchema>

/** The wire limits that go into a field's description, because the model can't be held to them (p4-w3.md section 2). */
type Json = Record<string, unknown>
const KEEP = new Set(['type', 'enum', 'required', 'additionalProperties', 'properties', 'items', 'description'])

/**
 * The reduced draft-07 schema the SDK gets as `outputFormat.schema`: types, `enum`, `required`, `additionalProperties:
 * false`, nothing else (the API's constrained decoding refuses `maxLength`, `maxItems` over 1, complex patterns and
 * `format`). A limit it drops goes into the field's `description`. A nullable becomes an `anyOf` with `{ type: 'null' }`. Built from the zod
 * schema, never copied by hand.
 */
export function reduceSchema(node: Json): Json {
  const out: Json = {}
  const notes: string[] = []
  for (const k of ['oneOf', 'allOf', 'not', '$ref']) if (k in node) throw new Error(`reduceSchema: ${k} is not supported`)
  const alt = node.anyOf
  if (Array.isArray(alt)) {
    const nulls = alt.filter(a => (a as Json).type === 'null')
    const rest = alt.filter(a => (a as Json).type !== 'null')
    if (rest.length !== 1 || nulls.length !== 1) throw new Error('reduceSchema: only a nullable union is supported')
    // The documented route for a nullable: `anyOf` the schema and `{ type: 'null' }` (a type list isn't mentioned).
    const { description, ...inner } = reduceSchema(rest[0] as Json)
    return { anyOf: [inner, { type: 'null' }], ...(description ? { description } : {}) }
  }
  if (typeof node.maxLength === 'number') notes.push(`at most ${node.maxLength} characters`)
  if (typeof node.minLength === 'number' && node.minLength > 0) notes.push(`at least ${node.minLength} character${node.minLength === 1 ? '' : 's'}`)
  if (typeof node.maxItems === 'number') notes.push(node.minItems === node.maxItems ? `exactly ${node.maxItems} items` : `at most ${node.maxItems} items`)
  else if (typeof node.minItems === 'number' && node.minItems > 0) notes.push(`at least ${node.minItems} items`)
  if (typeof node.pattern === 'string') notes.push(`matches ${node.pattern}`)
  for (const [k, v] of Object.entries(node)) {
    if (!KEEP.has(k)) continue
    if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v as Json).map(([p, s]) => [p, reduceSchema(s as Json)]))
    else if (k === 'items') out.items = reduceSchema(v as Json)
    else if (k !== 'description') out[k] = v
  }
  // Every object is closed (the structured-outputs docs require `additionalProperties: false` on each).
  if (out.type === 'object') out.additionalProperties = false
  const description = [typeof node.description === 'string' ? node.description : null, ...notes].filter(Boolean).join('; ')
  if (description) out.description = description
  return out
}

/** The wire schema of the morning check's result (`outputFormat.schema`). */
export const morningCheckWireSchema = (): Json => reduceSchema(z.toJSONSchema(MorningCheckResultSchema, { target: 'draft-7', io: 'input' }) as Json)
