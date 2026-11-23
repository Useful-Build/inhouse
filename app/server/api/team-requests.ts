// Routes 80 to 83 (P6a W3): requests to the Inhouse team. The access matrix decides who may call each (members and Admins
// create and list, the Inhouse team lists and answers, only the requester withdraws); the store decides status and owner
// inside its statement. An unknown id is 404 before the owner rule. Accepted exception: the Inhouse team reads request text
// without a grant, because a request is addressed to it. Every refusal that carries the request carries it as `current`.
import { TeamRequestIdSchema } from '../../shared/contract/audit.ts'
import { TeamRequestCreateInputSchema, TeamRequestRecordSchema, TeamRequestStatusInputSchema, TeamRequestWithdrawInputSchema, TeamRequestsListSchema } from '../../shared/contract/team-requests.ts'
import type { TeamRequestRecord } from '../../shared/contract/team-requests.ts'
import { readBody, storesOf, writer } from '../db/handler-kit.ts'
import type { ApiCtx } from '../db/handler-kit.ts'
import { apiError, apiJson } from '../http.ts'
import type { Handler } from '../routes.ts'
import type { TeamRequestRow, WriteOutcome } from '../team-requests/store.ts'

const instant = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })

/** `readerId` null: the Inhouse team, who gets no member ids (`requestedBy` left out, `mine` false). */
export const recordOf = (r: TeamRequestRow, readerId: string | null): TeamRequestRecord => TeamRequestRecordSchema.parse({
  id: r.id, kind: r.kind, subject: r.subject, text: r.text, ...(readerId === null ? {} : { requestedBy: r.requested_by }), mine: readerId !== null && r.requested_by === readerId,
  status: r.status, at: instant(r.created_at_ms), updatedAt: instant(r.updated_at_ms), rev: r.rev,
})

/** Who reads: a person's member id, or null for the Inhouse team. */
const readerOf = (c: ApiCtx): string | null => (c.principal.kind === 'person' ? writer(c).actorId : null)

const idOf = (c: ApiCtx): string | null => (TeamRequestIdSchema.safeParse(c.params.id).success ? c.params.id : null)

function answer(o: WriteOutcome, readerId: string | null): Response {
  if ('ok' in o) return apiJson(recordOf(o.ok, readerId))
  if ('conflict' in o) return apiError('conflict', { current: recordOf(o.conflict, readerId) })
  if (o.refused === 'not_found') return apiError('not_found')
  return apiError('forbidden', { reason: 'not_owner' })
}

/** Route 80 lists requests, optionally filtered by `status`. `?view=window` reads open and recently closed together. */
export const listTeamRequests: Handler = async c => {
  const params = [...new URL(c.request.url).searchParams]
  if (params.length > 1) return apiError('invalid')
  const [key, value] = params[0] ?? []
  const store = storesOf(c).teamRequests
  const reader = readerOf(c)
  const list = (rows: TeamRequestRow[]) => apiJson(TeamRequestsListSchema.parse({ items: rows.map(r => recordOf(r, reader)) }))
  if (key === 'view' && value === 'window') return list(await store.listWindow())
  if (key === undefined) return list(await store.list())
  if (key === 'status' && (value === 'open' || value === 'done' || value === 'declined' || value === 'withdrawn')) return list(await store.list(value))
  return apiError('invalid')
}

/** Route 81, `POST /api/team-requests` `{ kind, subject?, text }`. 403 `request_limit` at 50 open ones. */
export const createTeamRequest: Handler = async c => {
  const body = await readBody(c.request, TeamRequestCreateInputSchema)
  if ('error' in body) return body.error
  const o = await storesOf(c).teamRequests.create(body.ok, writer(c))
  if ('refused' in o) return apiError('forbidden', { reason: 'request_limit' })
  return apiJson(recordOf(o.ok, readerOf(c)), o.created ? 201 : 200)
}

/** Route 82, `PUT /api/team-requests/:id/status` `{ status, ifRev }`: the Inhouse team, from open only. */
export const setTeamRequestStatus: Handler = async c => {
  const id = idOf(c)
  if (!id) return apiError('not_found')
  const body = await readBody(c.request, TeamRequestStatusInputSchema)
  if ('error' in body) return body.error
  return answer(await storesOf(c).teamRequests.setStatus({ id, status: body.ok.status, ifRev: body.ok.ifRev }, writer(c)), readerOf(c))
}

/** Route 83, `PUT /api/team-requests/:id/withdrawn` `{ ifRev }`: the requester, from open only. */
export const withdrawTeamRequest: Handler = async c => {
  const id = idOf(c)
  if (!id) return apiError('not_found')
  const body = await readBody(c.request, TeamRequestWithdrawInputSchema)
  if ('error' in body) return body.error
  // An unknown id is 404 before the owner rule; then the matrix's `personal` rule runs on the request's owner.
  const row = await storesOf(c).teamRequests.get(id)
  if (!row) return apiError('not_found')
  c.access.requireObject({ ownerId: row.requested_by })
  return answer(await storesOf(c).teamRequests.withdraw({ id, ifRev: body.ok.ifRev }, writer(c)), readerOf(c))
}
