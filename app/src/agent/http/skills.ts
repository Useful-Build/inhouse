// The Skills page over HTTP (route 79, P6a W3): the skills the agent has. A plain request builder (no zod here: the entry's
// size budget); the transport parses the answer through the shared schema.
import type { SkillDef } from '../../../shared/contract/skill'
import type { Transport } from './transport'

/** Route 79: dataviz and ours. */
export const readSkills = (http: Transport): Promise<SkillDef[]> => http.call({ method: 'GET', path: '/api/skills', schema: 'skills' })
