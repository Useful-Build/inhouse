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

export const AgentErrorCodeSchema = z.enum(['offline', 'forbidden', 'conflict', 'unknown'])
export type AgentErrorCode = z.infer<typeof AgentErrorCodeSchema>

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

/** A length of time in ms. */
export const DurationMsSchema = z.number().nonnegative()
