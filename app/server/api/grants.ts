// Routes 16 to 18 (p2-design section 9, BD7): the support grants an Admin gives the Inhouse team. Who may call them is
// the matrix's (Admins and the Inhouse team read; only Admins create or end); the rules on the object (one live grant,
// an end only of a live grant at its rev) are the data layer's, in its statements.
import { GrantCreateInputSchema, GrantEndInputSchema, GrantIdSchema } from '../../shared/contract/grants.ts'
import { apiError, apiJson } from '../http.ts'
import { readBody, readQuery, storesOf, writer } from '../db/handler-kit.ts'
import type { ApiCtx } from '../db/handler-kit.ts'
import { brandAgent } from '../do/brand-agent/client.ts'
import { z } from 'zod'

/** Route 16, `GET /api/grants`: `{ items }`, newest first. */
export async function listGrants(c: ApiCtx): Promise<Response> {
  const query = readQuery(c.request, z.object({}).strict())
  if ('error' in query) return query.error
  return apiJson({ items: await storesOf(c).grants.list({ nowMs: c.nowMs, requestId: c.requestId }) })
}

/**
 * The BrandAgent's side of a grant (P3 design 4.10); a lost call is repaired by the object's authority sweep. Awaited,
 * with no timeout of its own: the object hears before the answer (an observable order), at the price of a slow object
 * delaying the Admin's answer.
 */
async function tellAgent(c: ApiCtx & { env: Pick<Env, 'BRAND_AGENT'> }, call: 'onGrantCreated' | 'onGrantEnded', act: () => Promise<void>) {
  try {
    await act()
  } catch (err) {
    console.error({ event: 'authority_call_lost', call, requestId: c.requestId, error: err instanceof Error ? err.name : 'unknown' })
  }
}

/**
 * Route 17, `POST /api/grants` `{ hours }`: 201 with the grant; 409 `grant_live` while one is live. The BrandAgent
 * schedules the grant's `grant-expiry` at its end (its sockets close `4403` then).
 */
export async function createGrant(c: ApiCtx & { env: Pick<Env, 'BRAND_AGENT'> }): Promise<Response> {
  const body = await readBody(c.request, GrantCreateInputSchema)
  if ('error' in body) return body.error
  const done = await storesOf(c).grants.create(body.ok.hours, writer(c))
  if (!('ok' in done)) return apiError('conflict', { reason: 'grant_live' })
  const grant = done.ok
  await tellAgent(c, 'onGrantCreated', () => brandAgent(c.env).onGrantCreated(grant.id, grant.endsAt.ms))
  return apiJson(grant, 201)
}

/**
 * Route 18, `POST /api/grants/:id/end` `{ ifRev }`: the ended grant; 409 with `current` when stale or not live. Once
 * ended, the BrandAgent closes the grant's sockets (`onGrantEnded`).
 */
export async function endGrant(c: ApiCtx & { env: Pick<Env, 'BRAND_AGENT'> }): Promise<Response> {
  const id = GrantIdSchema.safeParse(c.params.id)
  if (!id.success) return apiError('not_found')
  const body = await readBody(c.request, GrantEndInputSchema)
  if ('error' in body) return body.error
  const done = await storesOf(c).grants.end({ id: id.data, ifRev: body.ok.ifRev }, writer(c))
  if ('ok' in done) {
    await tellAgent(c, 'onGrantEnded', () => brandAgent(c.env).onGrantEnded(id.data))
    return apiJson(done.ok)
  }
  if ('conflict' in done) return apiError('conflict', { current: done.conflict })
  return apiError('not_found')
}
