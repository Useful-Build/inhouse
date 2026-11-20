// Routes 3 to 6 (p2-design section 3): the team list, invite, role change and removal. Access (Admin and the Inhouse
// team for the writes, decision 19; every signed-in person reads the list) is the matrix's, before these run; the rules on the object (already a
// member, the last Admin, a stale ifRev) are the data layer's, inside its statements.
import { InviteInputSchema, MemberIdSchema, MemberRemoveQuerySchema, RoleChangeInputSchema } from '../../shared/contract/members.ts'
import { apiError, apiJson } from '../http.ts'
import { encodeCursor, readBody, readPage, readQuery, storesOf, writer } from '../db/handler-kit.ts'
import type { ApiCtx } from '../db/handler-kit.ts'

/** `GET /api/members?cursor&limit`: every person row with its status (removed ones too, for history), by id. */
export async function listMembers(c: ApiCtx): Promise<Response> {
  const page = readPage(c.request)
  if ('error' in page) return page.error
  const { items, lastId } = await storesOf(c).members.list({ limit: page.ok.limit, afterId: page.ok.after })
  return apiJson({ items, nextCursor: lastId === null ? null : encodeCursor(lastId) })
}

/** `POST /api/members/invites` `{ name, email, title?, role }`: 201 with the invited member. */
export async function inviteMember(c: ApiCtx): Promise<Response> {
  const body = await readBody(c.request, InviteInputSchema)
  if ('error' in body) return body.error
  const done = await storesOf(c).members.invite(body.ok, writer(c))
  if ('refused' in done) return apiError('conflict', { reason: done.refused })
  return apiJson(done.ok, 201)
}

const memberIdParam = (c: ApiCtx): string | null => {
  const id = MemberIdSchema.safeParse(c.params.id)
  return id.success ? id.data : null
}

/** `PUT /api/members/:id/role` `{ role, ifRev }`. */
export async function changeMemberRole(c: ApiCtx): Promise<Response> {
  const id = memberIdParam(c)
  if (id === null) return apiError('not_found')
  const body = await readBody(c.request, RoleChangeInputSchema)
  if ('error' in body) return body.error
  const done = await storesOf(c).members.changeRole({ id, role: body.ok.role, ifRev: body.ok.ifRev }, writer(c))
  if ('ok' in done) return apiJson(done.ok)
  if ('conflict' in done) return apiError('conflict', { current: done.conflict })
  switch (done.refused) {
    case 'not_found': return apiError('not_found')
    case 'last_admin': return apiError('conflict', { reason: 'last_admin' })
    // Already that role at that rev: nothing to change, and no audit line.
    case 'unchanged': {
      const now = await storesOf(c).members.get(id)
      return now ? apiJson(now) : apiError('not_found')
    }
  }
}

/** `DELETE /api/members/:id?ifRev=`: the member is removed (the row and its id stay). */
export async function removeMember(c: ApiCtx): Promise<Response> {
  const id = memberIdParam(c)
  if (id === null) return apiError('not_found')
  const query = readQuery(c.request, MemberRemoveQuerySchema)
  if ('error' in query) return query.error
  const done = await storesOf(c).members.remove({ id, ifRev: query.ok.ifRev }, writer(c))
  if ('ok' in done) return apiJson(done.ok)
  if ('conflict' in done) return apiError('conflict', { current: done.conflict })
  return done.refused === 'last_admin' ? apiError('conflict', { reason: 'last_admin' }) : apiError('not_found')
}
