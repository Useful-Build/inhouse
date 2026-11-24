// The Skills page over HTTP (routes 79, 84 and 85; P6a W3 and brand skills): the skills the agent has, one skill's
// instructions, and deleting a brand skill. Plain request builders (no zod here: the entry's size budget); the transport
// parses each answer through the shared schema.
import type { SkillDef, SkillPage } from '../../../shared/contract/skill'
import type { Contract, Transport } from './transport'

/** Route 79: dataviz and ours, then the brand's own. */
export const readSkills = (http: Transport): Promise<SkillDef[]> => http.call({ method: 'GET', path: '/api/skills', schema: 'skills' })

/** Route 84: a skill's instructions (no frontmatter), the tools it reads and when it last changed. */
export const readSkillPage = (http: Transport, name: string): Promise<SkillPage> =>
  http.call({ method: 'GET', path: `/api/skills/${encodeURIComponent(name)}`, schema: 'skillPage' })

/** Route 85: a brand skill, at the rev last read. */
export const postSkillDelete = (http: Transport, k: Contract, id: string, ifRev: number): Promise<SkillDef> =>
  http.call({ method: 'POST', path: `/api/skills/brand/${encodeURIComponent(id)}/delete`, schema: 'skill', json: k.BODIES.skillDelete.parse({ ifRev }) })
