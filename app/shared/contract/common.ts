// Values every resource shares: the stages, the demo scenarios, a model's effort and the error codes.
import { z } from 'zod'

export const StageSchema = z.enum(['Watch', 'Act', 'Run'])
export type Stage = z.infer<typeof StageSchema>

/** 0 Watch, 1 Act, 2 Run. `need` fields in the sample data use the same index. */
export const StageIndexSchema = z.union([z.literal(0), z.literal(1), z.literal(2)])
export type StageIndex = z.infer<typeof StageIndexSchema>

export const ScenarioSchema = z.enum(['Normal', 'First day', 'Loading', 'Tool disconnected', 'Cap reached'])
export type Scenario = z.infer<typeof ScenarioSchema>

/** How hard a model thinks, as the engine names it. */
export const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
export type Effort = z.infer<typeof EffortSchema>

export const AgentErrorCodeSchema = z.enum([
  'offline', 'forbidden', 'conflict', 'not_found', 'unavailable', 'unknown',
  // P2: a missing or bad sign-in, too many requests, a spending cap hit (P3 chooses it) and a body or value that fails its schema.
  'unauthorized', 'rate_limited', 'cap_reached', 'invalid',
])
export type AgentErrorCode = z.infer<typeof AgentErrorCodeSchema>

/** Why a request was refused, when the code alone doesn't say (p2-design.md section 4). The UI reads `not_invited` and `removed` as "You're not on this team". */
export const ErrorReasonSchema = z.enum([
  'not_invited', 'removed', 'bad_origin', 'grant_required', 'admin_read_only', 'not_owner', 'wrong_scope', 'last_admin',
  'already_member', 'grant_live', 'bad_type', 'too_large',
])
export type ErrorReason = z.infer<typeof ErrorReasonSchema>

/** The body of every refused `/api/*` request: `{ error: { code, reason?, current? } }`. `current` is the record as it is now, on a stale `ifRev`. */
export const ErrorBodySchema = z.object({
  error: z.object({
    code: AgentErrorCodeSchema,
    reason: ErrorReasonSchema.optional(),
    current: z.record(z.string(), z.unknown()).optional(),
  }),
})
export type ErrorBody = z.infer<typeof ErrorBodySchema>

/** One entry per list in `AgentData`, so a failed read names what failed (C3). `members` and `audit` also page. */
export const ResourceKeySchema = z.enum([
  'meta', 'problems', 'tools', 'routines', 'skills', 'usage', 'members', 'rules', 'grants', 'memory', 'audit', 'activity', 'notifications',
  'models', 'chat', 'library',
])
export type ResourceKey = z.infer<typeof ResourceKeySchema>

/** Where one resource stands: loading, ready, or failed with the error's code. */
export const ResourceStatusSchema = z.object({ status: z.enum(['loading', 'ready', 'error']), error: AgentErrorCodeSchema.optional() })
export type ResourceStatus = z.infer<typeof ResourceStatusSchema>

/** Two strings shown side by side: a label and its value, or a text and its source number. */
export const PairSchema = z.tuple([z.string(), z.string()])

/** One moment: an ISO 8601 date and time with its offset, and the same moment as epoch ms. Both always agree. */
export const InstantSchema = z.object({ iso: z.iso.datetime({ offset: true }), ms: z.number().int() })
  .refine(v => Date.parse(v.iso) === v.ms, { message: 'iso and ms name different moments' })
export type Instant = z.infer<typeof InstantSchema>

/** An amount in the currency's minor unit (cents for USD) and its ISO 4217 code. */
export const MoneySchema = z.object({ minor: z.number().int(), currency: z.string().regex(/^[A-Z]{3}$/) })
export type Money = z.infer<typeof MoneySchema>

/** A wall-clock time in the brand's time zone, for a schedule ("6:00 AM" every weekday). */
export const ClockTimeSchema = z.object({ hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) })
export type ClockTime = z.infer<typeof ClockTimeSchema>

/**
 * A sentence with times in it: `text` names each time as `{key:time}` ("6:04 AM") or `{key:weekday}` ("Thu, Nov 19"),
 * and `times` holds each key's instant. The UI writes the sentence through format.ts (`fmtProse`), so every time in it
 * shows in the same zone as the rest of the screen.
 */
export const ProseSchema = z.object({ text: z.string(), times: z.record(z.string(), InstantSchema) })
export type Prose = z.infer<typeof ProseSchema>

/** A length of time in ms. */
export const DurationMsSchema = z.number().nonnegative()
