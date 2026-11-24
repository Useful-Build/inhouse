// The brand skills tool (P6a, master plan standing decision 6): `skill_save`, as the run's person. The agent writes a
// brand skill only here, never as a file. A routine's own run (`m_system`) has no person to make or own a skill, so it
// gets a refusal it can read. The rules (name, description, instructions, the brand's 25 skills and their size, who
// may change one) are the store's.
import { z } from 'zod'
import { BRAND_SKILL_BODY_MAX, BRAND_SKILL_DESCRIPTION_MAX, BRAND_SKILL_NAME_MAX, BRAND_SKILLS_MAX } from '../../../../shared/protocol/brand-skills.ts'
import { SYSTEM_MEMBER_ID } from '../../../db/ids.ts'
import { saveSkill } from '../../../brand-skills/store.ts'
import { answer, refusal, tool } from '../../server/tool.ts'
import type { InhouseToolName, ToolHandler } from '../../server/tool.ts'

export const NEEDS_PERSON_TEXT = 'A skill is made by a person in a chat, not by a routine. Tell the person in the summary instead.'
export const NOT_OWNER_TEXT = 'Only the person who made this skill, or an admin, can change it. Tell the person, and offer to save it under a new name instead.'
export const LIMIT_TEXT = `The brand already has ${BRAND_SKILLS_MAX} skills, the most it can have. Tell the person: they can delete one on the Skills page first.`
export const TOO_LARGE_TEXT = "The brand's skills would be too long together with this one. Make the instructions shorter, or ask the person to delete a skill they no longer use on the Skills page."
export const CONFLICT_TEXT = 'This skill changed while you were saving it. Read it again with the person, then save once more.'

export const handlers: Partial<Record<InhouseToolName, ToolHandler>> = {
  skill_save: tool({
    // Wider than the rules on purpose: the store checks them and says what to fix, in words the agent can pass on.
    input: z.object({
      name: z.string().max(200).describe(`The skill's name: lower-case words joined by hyphens, at most ${BRAND_SKILL_NAME_MAX} characters (for example "weekly-wholesale-report"). An existing brand skill's name replaces that skill.`),
      description: z.string().max(4000).describe(`One line, at most ${BRAND_SKILL_DESCRIPTION_MAX} characters: what the skill does and when to use it. No "<" or ">".`),
      body: z.string().max(BRAND_SKILL_BODY_MAX * 2).describe(`The instructions in Markdown, at most ${BRAND_SKILL_BODY_MAX} characters. No frontmatter: a leading "---" block is dropped.`),
    }).strict(),
    async call(a, scope, deps) {
      if (scope.memberId === SYSTEM_MEMBER_ID) return refusal('forbidden', NEEDS_PERSON_TEXT)
      const o = await saveSkill(deps.db, a, { actorId: scope.memberId, requestId: scope.requestId, nowMs: scope.nowMs })
      if ('refused' in o) {
        switch (o.refused) {
          case 'invalid': return refusal('invalid', `Not saved. ${o.why}`)
          case 'inactive': return refusal('forbidden', 'Only an active team member can save a skill.')
          case 'not_owner': return refusal('forbidden', NOT_OWNER_TEXT)
          case 'limit': return refusal('skill_limit', LIMIT_TEXT)
          case 'too_large': return refusal('too_large', TOO_LARGE_TEXT)
          case 'conflict': return refusal('conflict', CONFLICT_TEXT)
        }
      }
      const s = o.ok
      const data = { skill_id: s.id, name: s.name, created: o.created }
      return o.created
        ? answer(`Saved the new skill "${s.name}". It's live for the whole team from the next chat, and it's on the Skills page. Tell the person.`, data)
        : answer(`Saved the changes to "${s.name}". They apply from the next chat. Tell the person.`, data)
    },
  }),
}
