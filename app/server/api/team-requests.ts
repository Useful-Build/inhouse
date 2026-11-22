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

export const recordOf = (r: TeamRequestRow, readerId: string): TeamRequestRecord => TeamRequestRecordSchema.parse({
  id: r.id, kind: r.kind, subject: r.subject, text: r.text, requestedBy: r.requested_by, mine: r.requested_by === readerId,
  status: r.status, at: instant(r.created_at_ms), updatedAt: instant(r.updated_at_ms), rev: r.rev,
})

const idOf = (c: ApiCtx): string | null => (TeamRequestIdSchema.safeParse(c.params.id).success ? c.params.id : null)

function answer(o: WriteOutcome, readerId: string): Response {
  if ('ok' in o) return apiJson(recordOf(o.ok, readerId))
  if ('conflict' in o) return apiError('conflict', { current: recordOf(o.conflict, readerId) })
  if (o.refused === 'not_found') return apiError('not_found')
  return apiError('forbidden', { reason: 'not_owner' })
}

/** Route 80, `GET /api/team-requests` (`?status=open` and the other three): newest first, at most 200. */
export const listTeamRequests: Handler = async c => {
  const params = [...new URL(c.request.url).searchParams]
  let status: 'open' | 'done' | 'declined' | 'withdrawn' | undefined
  if (params.length > 1 || (params.length === 1 && params[0]![0] !== 'status')) return apiError('invalid')
  if (params.length === 1) {
    const v = params[0]![1]
    if (v !== 'open' && v !== 'done' && v !== 'declined' && v !== 'withdrawn') return apiError('invalid')
    status = v
  }
  const rows = await storesOf(c).teamRequests.list(status)
  return apiJson(TeamRequestsListSchema.parse({ items: rows.map(r => recordOf(r, writer(c).actorId)) }))
}

/** Route 81, `POST /api/team-requests` `{ kind, subject?, text }`. 403 `request_limit` at 50 open ones. */
export const createTeamRequest: Handler = async c => {
  const body = await readBody(c.request, TeamRequestCreateInputSchema)
  if ('error' in body) return body.error
  const o = await storesOf(c).teamRequests.create(body.ok, writer(c))
  if ('refused' in o) return apiError('forbidden', { reason: 'request_limit' })
  return apiJson(recordOf(o.ok, writer(c).actorId), o.created ? 201 : 200)
}

/** Route 82, `PUT /api/team-requests/:id/status` `{ status, ifRev }`: the Inhouse team, from open only. */
export const setTeamRequestStatus: Handler = async c => {
  const id = idOf(c)
  if (!id) return apiError('not_found')
  const body = await readBody(c.request, TeamRequestStatusInputSchema)
  if ('error' in body) return body.error
  return answer(await storesOf(c).teamRequests.setStatus({ id, status: body.ok.status, ifRev: body.ok.ifRev }, writer(c)), writer(c).actorId)
}

/** Route 83, `PUT /api/team-requests/:id/withdrawn` `{ ifRev }`: the requester, from open only. */
export const withdrawTeamRequest: Handler = async c => {
  const id = idOf(c)
  if (!id) return apiError('not_found')
  const body = await readBody(c.request, TeamRequestWithdrawInputSchema)
  if ('error' in body) return body.error
  return answer(await storesOf(c).teamRequests.withdraw({ id, ifRev: body.ok.ifRev }, writer(c)), writer(c).actorId)
}
