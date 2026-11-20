// What `attach()` delivers while the agent answers: the socket's run events (runs.ts), each with its seq and time.
import { z } from 'zod'
import { InstantSchema } from './common.ts'
import { ChatEventSchema, RunIdSchema } from './runs.ts'

/** A run's event as the client hands it on: in order by `seq`, each once. The events are the socket's own (`ChatEventSchema`). */
export const RunEventSchema = ChatEventSchema
export type RunEvent = z.infer<typeof RunEventSchema>

export const RunFrameSchema = z.object({ runId: RunIdSchema, seq: z.number().int().min(1), at: InstantSchema, event: ChatEventSchema })
export type RunFrame = z.infer<typeof RunFrameSchema>
