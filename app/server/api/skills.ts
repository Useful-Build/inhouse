// Route 79, `GET /api/skills` (P6a W3): the skills the agent has, in the page's `SkillDef` shape. Fixed list, no query.
import { SkillDefSchema } from '../../shared/contract/skill.ts'
import { z } from 'zod'
import { apiError, apiJson } from '../http.ts'
import type { Handler } from '../routes.ts'
import { SKILLS } from '../skills/list.ts'

const SkillsAnswerSchema = z.array(SkillDefSchema)

export const listSkills: Handler = async c => {
  if (new URL(c.request.url).search !== '') return apiError('invalid')
  return apiJson(SkillsAnswerSchema.parse(SKILLS))
}
