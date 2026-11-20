// Skills the agent has, and the ones it suggests.
import './jitless.ts'
import { z } from 'zod'
import { StageIndexSchema } from './common.ts'

export const SkillDefSchema = z.object({ n: z.string(), d: z.string(), icon: z.string(), need: StageIndexSchema, by: z.string(), used: z.string(), mine: z.boolean().optional() })
export type SkillDef = z.infer<typeof SkillDefSchema>

export const SkillSuggestionSchema = z.object({ n: z.string(), d: z.string(), icon: z.string() })
export type SkillSuggestion = z.infer<typeof SkillSuggestionSchema>
