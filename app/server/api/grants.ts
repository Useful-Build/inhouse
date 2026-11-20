// Routes 16 to 18 (p2-design section 9, BD7): the support grants an Admin gives the Inhouse team. Who may call them is
// the matrix's (Admins and the Inhouse team read; only Admins create or end); the rules on the object (one live grant,
// an end only of a live grant at its rev) are the data layer's, in its statements.
import { GrantCreateInputSchema, GrantEndInputSchema, GrantIdSchema } from '../../shared/contract/grants.ts'
import { apiError, apiJson } from '../http.ts'
import { readBody, readQuery, storesOf, writer } from '../db/handler-kit.ts'
import type { ApiCtx } from '../db/handler-kit.ts'
import { z } from 'zod'

/** Route 16, `GET /api/grants`: `{ items }`, newest first. */
export async function listGrants(c: ApiCtx): Promise<Response> {
  const query = readQuery(c.request, z.object({}).strict())
  if ('error' in query) return query.error
  return apiJson({ items: await storesOf(c).grants.list({ nowMs: c.nowMs, requestId: c.requestId }) })
}

/** Route 17, `POST /api/grants` `{ hours }`: 201 with the grant; 409 `grant_live` while one is live. */
export async function createGrant(c: ApiCtx): Promise<Response> {
  const body = await readBody(c.request, GrantCreateInputSchema)
  if ('error' in body) return body.error
  const done = await storesOf(c).grants.create(body.ok.hours, writer(c))
  return 'ok' in done ? apiJson(done.ok, 201) : apiError('conflict', { reason: 'grant_live' })
}

/** Route 18, `POST /api/grants/:id/end` `{ ifRev }`: the ended grant; 409 with `current` when stale or not live. */
export async function endGrant(c: ApiCtx): Promise<Response> {
  const id = GrantIdSchema.safeParse(c.params.id)
  if (!id.success) return apiError('not_found')
  const body = await readBody(c.request, GrantEndInputSchema)
  if ('error' in body) return body.error
  const done = await storesOf(c).grants.end({ id: id.data, ifRev: body.ok.ifRev }, writer(c))
  if ('ok' in done) return apiJson(done.ok)
  if ('conflict' in done) return apiError('conflict', { current: done.conflict })
  return apiError('not_found')
}
