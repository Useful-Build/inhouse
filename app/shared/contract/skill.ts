// Skills the agent has, and the ones it suggests.
import { z } from 'zod'
import { InstantSchema, StageIndexSchema } from './common.ts'

/** One saved version of a skill: who changed it, when, and their one-line note. */
export const SkillVersionSchema = z.object({ by: z.string(), at: InstantSchema, note: z.string() })
export type SkillVersion = z.infer<typeof SkillVersionSchema>

export const SkillDefSchema = z.object({
  n: z.string(), d: z.string(), icon: z.string(), need: StageIndexSchema, by: z.string(), used: z.string(), mine: z.boolean().optional(),
  // The skill's page. Each is optional: without them the page shows its header and side rail only.
  /** The skill's instructions as markdown (a SKILL.md; any frontmatter is stripped when it's shown). */
  body: z.string().optional(),
  /** The tools it reads, by tool key (`shopify`). */
  tools: z.array(z.string()).optional(),
  /** When it last changed. */
  updatedAt: InstantSchema.optional(),
  /** An ask that uses it, for the page's try-it composer. */
  example: z.string().optional(),
  /** The routines that use it, by routine id. */
  routines: z.array(z.string()).optional(),
  /** Its saved versions, newest first. */
  versions: z.array(SkillVersionSchema).optional(),
})
export type SkillDef = z.infer<typeof SkillDefSchema>

export const SkillSuggestionSchema = z.object({ n: z.string(), d: z.string(), icon: z.string() })
export type SkillSuggestion = z.infer<typeof SkillSuggestionSchema>
