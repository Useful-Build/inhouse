// Team memory approval (P6a, W2): routes 77 and 78. Who may call each is the matrix's (Admins, and the Inhouse team
// under a live grant, already audited as `support.access`); the rules on the fact (brand, waiting, its rev) are the
// store's, in its one guarded statement, with the decision's audit line in the same batch.
import { MemoryIdSchema } from '../../shared/contract/memory.ts'
import { MemoryApproveInputSchema } from '../../shared/contract/memory-approvals.ts'
import type { WaitingMemoryList } from '../../shared/contract/memory-approvals.ts'
import { apiError, apiJson } from '../http.ts'
import { readBody, readQuery, storesOf, writer } from '../db/handler-kit.ts'
import type { ApiCtx } from '../db/handler-kit.ts'
import { factLine } from '../mcp/tools/memory/store.ts'
import type { SetForgottenResult } from '../mcp/tools/memory/store.ts'
import { z } from 'zod'

/** The most waiting facts route 77 answers. */
export const WAITING_LIMIT = 200

const answer = (r: SetForgottenResult): Response =>
  'ok' in r ? apiJson(factLine(r.ok)) : 'conflict' in r ? apiError('conflict', { current: factLine(r.conflict) }) : apiError('not_found')

/** Route 77, `GET /api/memory/waiting`: the team's waiting facts, newest first, at most 200 (`WaitingMemoryList`). */
export async function listWaitingMemory(c: ApiCtx): Promise<Response> {
  const query = readQuery(c.request, z.object({}).strict())
  if ('error' in query) return query.error
  const p = c.principal
  if (p.kind === 'service') throw new Error(`${p.name} has no waiting list`)
  const facts = await storesOf(c).memory.waiting(WAITING_LIMIT)
  const data: WaitingMemoryList = { facts: facts.map(f => ({ ...factLine(f), kind: 'memory' as const })) }
  return apiJson(data)
}

/**
 * Route 78, `PUT /api/memory/brand/:id/approved` `{ approved, ifRev }`: approve (`active`) or reject (`forgotten`) a
 * waiting team fact at the rev last read. A person fact or an unknown id is 404; anything not waiting at that rev is a
 * conflict with the fact as it is.
 */
export async function approveBrandMemory(c: ApiCtx): Promise<Response> {
  const id = MemoryIdSchema.safeParse(c.params.id)
  if (!id.success) return apiError('not_found')
  const body = await readBody(c.request, MemoryApproveInputSchema)
  if ('error' in body) return body.error
  const memory = storesOf(c).memory
  const found = await memory.byId(id.data)
  if (!found || found.scope !== 'brand') return apiError('not_found')
  return answer(await memory.setBrandApproved({ id: id.data, approved: body.ok.approved, ifRev: body.ok.ifRev }, writer(c)))
}
