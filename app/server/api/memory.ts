// Memory (P3, p3-design sections 3 and 10): routes 43 to 45, the Memory and Team memory pages. Owner: W6 (p3-w6.md).
// Who may call each is the matrix's; the rules on the fact (whose it is, its rev and status) are the store's, in its
// statements. Route 43 reads through the one visibility rule the memory tools use.
import { MemoryForgetInputSchema, MemoryIdSchema } from '../../shared/contract/memory.ts'
import type { MemoryData } from '../../shared/contract/memory.ts'
import { apiError, apiJson } from '../http.ts'
import { readBody, readQuery, storesOf, writer } from '../db/handler-kit.ts'
import type { ApiCtx } from '../db/handler-kit.ts'
import { factLine } from '../mcp/tools/memory/store.ts'
import type { SetForgottenResult } from '../mcp/tools/memory/store.ts'
import { z } from 'zod'

/** The one group team lines show under until facts carry a topic. */
export const TEAM_GROUP = 'Shared with the team'

const answer = (r: SetForgottenResult): Response =>
  'ok' in r ? apiJson(factLine(r.ok)) : 'conflict' in r ? apiError('conflict', { current: factLine(r.conflict) }) : apiError('not_found')

/** Route 43, `GET /api/memory`: the team's active facts and the caller's own (`MemoryData`). */
export async function listMemory(c: ApiCtx): Promise<Response> {
  const query = readQuery(c.request, z.object({}).strict())
  if ('error' in query) return query.error
  const p = c.principal
  if (p.kind === 'service') throw new Error(`${p.name} has no memory page`)
  const { team, personal } = await storesOf(c).memory.page(p.memberId)
  const data: MemoryData = {
    team: team.length > 0 ? [{ group: TEAM_GROUP, lines: team.map(factLine) }] : [],
    personal: personal.map(factLine),
  }
  return apiJson(data)
}

/** Route 44, `PUT /api/memory/personal/:id/forgotten` `{ forgotten, ifRev }`: the owner's own fact; anyone else's is 404. */
export async function forgetPersonalMemory(c: ApiCtx): Promise<Response> {
  const id = MemoryIdSchema.safeParse(c.params.id)
  if (!id.success) return apiError('not_found')
  const body = await readBody(c.request, MemoryForgetInputSchema)
  if ('error' in body) return body.error
  const at = writer(c)
  const memory = storesOf(c).memory
  // Prefilter: another member's fact, or a team fact, answers 404 before the object check (p3-design section 3).
  const found = await memory.byId(id.data)
  if (!found || found.scope !== 'person' || found.ownerId !== at.actorId) return apiError('not_found')
  c.access.requireObject({ ownerId: found.ownerId })
  return answer(await memory.setPersonForgotten({ id: id.data, ownerId: at.actorId, forgotten: body.ok.forgotten, ifRev: body.ok.ifRev }, at))
}

/**
 * Route 45, `PUT /api/memory/brand/:id/forgotten` `{ forgotten, ifRev }`: an Admin (or, item 19, the Inhouse team under
 * a live grant, already audited as `support.access`) forgets a team fact or undoes that; the store writes its own line.
 */
export async function forgetBrandMemory(c: ApiCtx): Promise<Response> {
  const id = MemoryIdSchema.safeParse(c.params.id)
  if (!id.success) return apiError('not_found')
  const body = await readBody(c.request, MemoryForgetInputSchema)
  if ('error' in body) return body.error
  const memory = storesOf(c).memory
  const found = await memory.byId(id.data)
  if (!found || found.scope !== 'brand') return apiError('not_found')
  return answer(await memory.setBrandForgotten({ id: id.data, forgotten: body.ok.forgotten, ifRev: body.ok.ifRev }, writer(c)))
}
