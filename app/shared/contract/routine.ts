// Routines: the jobs the agent runs on a schedule, and a Run now.
import './jitless.ts'
import { z } from 'zod'
import { ClockTimeSchema, InstantSchema, StageIndexSchema } from './common.ts'

export const RoutineDefSchema = z.object({
  /** The agent's own id for the routine: stable, and what runRoutine, deleteRoutine and restoreRoutine take. */
  id: z.string(),
  name: z.string(),
  what: z.string(),
  /** 'Daily' or 'Weekly' today; any other text is shown as it is. */
  freq: z.string(),
  day: z.string(),
  /** The time of day it runs, in the brand's time zone. */
  time: ClockTimeSchema,
  /** When it runs next. */
  next: InstantSchema,
  need: StageIndexSchema,
  money: z.boolean().optional(),
  /** Its last run: when, and what it found ("found 6 things"). */
  last: z.object({ at: InstantSchema, result: z.string() }).optional(),
  /** Made in a sample chat (the stuck orders chat): listed only from the stage it needs, since below it the chat couldn't make it. */
  inChat: z.boolean().optional(),
  /** Revision of this routine (a switch, a delete or a restore bumps it): a write sends it back as `ifRev`. */
  rev: z.number().int().min(1),
})
export type RoutineDef = z.infer<typeof RoutineDefSchema>

/** One Run now. `routine` is the routine's `id`; `at` is when; `trace` is the run's steps when the agent has them; `result` is what the run found, when the agent says. */
export const RoutineRunSchema = z.object({ routine: z.string(), at: InstantSchema, trace: z.string().optional(), result: z.string().optional() })
export type RoutineRun = z.infer<typeof RoutineRunSchema>
