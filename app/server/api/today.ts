// Today's routes (P4 W3, p4-w3.md section 5). Row 57 `GET /api/today`: the cards to show and the set-aside records.
// Row 58 `PUT /api/today/:id/aside` `{ reason, ifRev }`: a snooze, a dismissal or an Undo (null), audited
// (`today.set_aside`) and, for a set-aside, an Activity line from a fixed template. Both are brand_data: members, Admins
// and the Inhouse team under a live grant (the matrix and the request path decide).
import { TodayItemIdSchema } from '../../shared/contract/audit.ts'
import { SetAsideBodySchema, TodayAnswerSchema } from '../../shared/contract/today.ts'
import { apiError, apiJson } from '../http.ts'
import { readBody, readQuery, storesOf, writer } from '../db/handler-kit.ts'
import type { ApiCtx } from '../db/handler-kit.ts'
import { z } from 'zod'

export async function getToday(c: ApiCtx): Promise<Response> {
  const query = readQuery(c.request, z.object({}).strict())
  if ('error' in query) return query.error
  return apiJson(TodayAnswerSchema.parse(await storesOf(c).today.read(c.nowMs)))
}

export async function putAside(c: ApiCtx): Promise<Response> {
  const id = TodayItemIdSchema.safeParse(c.params.id)
  if (!id.success) return apiError('not_found')
  const body = await readBody(c.request, SetAsideBodySchema)
  if ('error' in body) return body.error
  const done = await storesOf(c).today.setAside({ id: id.data, reason: body.ok.reason, ifRev: body.ok.ifRev }, writer(c))
  if ('ok' in done) return apiJson(done.ok)
  if ('conflict' in done) return apiError('conflict', { current: done.conflict })
  return apiError('not_found')
}
