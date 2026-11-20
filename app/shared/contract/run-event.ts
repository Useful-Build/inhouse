// The events `ask()` streams while the agent answers.
import './jitless.ts'
import { z } from 'zod'
import { DurationMsSchema, InstantSchema, MoneySchema } from './common.ts'
import { MessagePartSchema } from './chat.ts'

export const RunEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run.started'), runId: z.string() }),
  z.object({ type: z.literal('step'), label: z.string() }),
  /** Phase 2: the agent may carry the model id that answered and when; the store falls back to its own.
   *  `trace` is the turn's trace id (`getTrace`): each message sent into a run starts a turn with its own, the run's id
   *  for the first turn and `${runId}-t${n}` for the nth (the store names a failed turn's error by it). */
  z.object({ type: z.literal('part'), part: MessagePartSchema, trace: z.string(), model: z.string().optional(), at: InstantSchema.optional() }),
  /** A message sent into the running answer (`send`) is now being answered: the store adds it as the person's message and the run goes on. */
  z.object({ type: z.literal('turn.started'), text: z.string() }),
  z.object({ type: z.literal('approval.requested'), approvalId: z.string() }),
  /** Comes only when nothing sent into the run is still waiting. */
  z.object({ type: z.literal('run.finished'), runId: z.string(), steps: z.number(), durationMs: DurationMsSchema, cost: MoneySchema }),
  z.object({ type: z.literal('run.failed'), runId: z.string(), message: z.string() }),
  z.object({ type: z.literal('run.stopped'), runId: z.string() }),
])
export type RunEvent = z.infer<typeof RunEventSchema>
