// The skills routes. Route 79, `GET /api/skills` (P6a W3): the skills the agent has, ours and then the brand's own, in
// the page's `SkillDef` shape. Route 84, `GET /api/skills/:name`: one skill's instructions. Route 85,
// `POST /api/skills/brand/:id/delete` `{ ifRev }`: its maker or an admin deletes a brand skill (P6a brand skills, master
// plan standing decision 6). The matrix says who may call each; who may delete a skill is the store's, in its statement.
import { BrandSkillIdSchema } from '../../shared/contract/audit.ts'
import { BrandSkillDeleteInputSchema, SkillDefSchema, SkillPageSchema } from '../../shared/contract/skill.ts'
import type { SkillDef } from '../../shared/contract/skill.ts'
import { brandSkillNameProblem } from '../../shared/protocol/brand-skills.ts'
import { z } from 'zod'
import { readBody, storesOf, writer } from '../db/handler-kit.ts'
import type { ApiCtx } from '../db/handler-kit.ts'
import { apiError, apiJson } from '../http.ts'
import type { Handler } from '../routes.ts'
import type { BrandSkillListed } from '../brand-skills/store.ts'
import { SKILLS } from '../skills/list.ts'
import { ourSkillPage } from '../skills/pages.ts'

const SkillsAnswerSchema = z.array(SkillDefSchema)
const instant = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })

/** Who may change a brand skill: a person who made it, or an admin (when its maker's data is cleared, only admins). The Inhouse team reads them, and changes none. */
const changerOf = (c: ApiCtx): ((s: BrandSkillListed) => boolean) => {
  const p = c.principal
  if (p.kind !== 'person') return () => false
  return s => p.role === 'admin' || s.created_by === p.memberId
}

/** A brand skill as the Skills page lists it. */
export const brandSkillDef = (s: BrandSkillListed, canChange: boolean): SkillDef => ({
  n: s.name, d: s.description, icon: 'menu_book', need: 0, by: s.creator_name ?? 'a former member', used: '', mine: true,
  updatedAt: instant(s.updated_at_ms), id: s.id, rev: s.rev, canChange,
})

/** Route 79: ours, then the brand's own by name. */
export const listSkills: Handler = async c => {
  if (new URL(c.request.url).search !== '') return apiError('invalid')
  const may = changerOf(c)
  const brand = await storesOf(c).brandSkills.list()
  return apiJson(SkillsAnswerSchema.parse([...SKILLS, ...brand.map(s => brandSkillDef(s, may(s)))]))
}

/** Route 84: one skill's instructions (no frontmatter), the tools it reads (none of ours reads a connected tool) and when it last changed. */
export const readSkill: Handler = async c => {
  if (new URL(c.request.url).search !== '') return apiError('invalid')
  const name = c.params.name ?? ''
  const ours = ourSkillPage(name)
  if (ours) return apiJson(SkillPageSchema.parse({ body: ours.body, tools: [], updatedAt: instant(ours.changedAtMs) }))
  if (brandSkillNameProblem(name) !== null) return apiError('not_found')
  const s = await storesOf(c).brandSkills.get(name)
  if (!s) return apiError('not_found')
  return apiJson(SkillPageSchema.parse({ body: s.body, tools: [], updatedAt: instant(s.updated_at_ms) }))
}

/** Route 85: a brand skill at the rev last read. Unknown id 404 before who may; a stale rev is a conflict with the skill as it is. */
export const deleteBrandSkill: Handler = async c => {
  const id = BrandSkillIdSchema.safeParse(c.params.id)
  if (!id.success) return apiError('not_found')
  const body = await readBody(c.request, BrandSkillDeleteInputSchema)
  if ('error' in body) return body.error
  const o = await storesOf(c).brandSkills.remove({ id: id.data, ifRev: body.ok.ifRev }, writer(c))
  const may = changerOf(c)
  if ('ok' in o) return apiJson(brandSkillDef(o.ok, true))
  if ('conflict' in o) {
    const now = await storesOf(c).brandSkills.get(o.conflict.name)
    return apiError('conflict', { current: now?.id === id.data ? brandSkillDef(now, may(now)) : null })
  }
  if (o.refused === 'not_found') return apiError('not_found')
  return apiError('forbidden', { reason: 'not_owner' })
}
