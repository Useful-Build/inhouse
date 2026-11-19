// Routines: the jobs the agent runs on a schedule, and a Run now.
import { z } from 'zod'
import { StageIndexSchema } from './common.ts'

export const RoutineDefSchema = z.object({
  /** The agent's own id for the routine: stable, and what runRoutine, deleteRoutine and restoreRoutine take. */
  id: z.string(),
  name: z.string(),
  what: z.string(),
  /** 'Daily' or 'Weekly' today; any other text is shown as it is. */
  freq: z.string(),
  day: z.string(),
  time: z.string(),
  next: z.string(),
  need: StageIndexSchema,
  money: z.boolean().optional(),
  last: z.string().optional(),
  /** Made in a sample chat (the stuck orders chat): listed only from the stage it needs, since below it the chat couldn't make it. */
  inChat: z.boolean().optional(),
})
export type RoutineDef = z.infer<typeof RoutineDefSchema>

/** One Run now. `routine` is the routine's `id`; `at` is shown, `atMin` sorts; `trace` is the run's steps when the agent has them; `result` is what the run found, when the agent says. */
export const RoutineRunSchema = z.object({ routine: z.string(), at: z.string(), atMin: z.number(), trace: z.string().optional(), result: z.string().optional() })
export type RoutineRun = z.infer<typeof RoutineRunSchema>
