// The models a team can pick for an answer.
import { z } from 'zod'
import { EffortSchema } from './common.ts'

/** A model from models.json, with its default effort. */
export const ModelModeSchema = z.object({ id: z.string(), label: z.string(), model: z.string(), sub: z.string(), effort: EffortSchema })
export type ModelMode = z.infer<typeof ModelModeSchema>
