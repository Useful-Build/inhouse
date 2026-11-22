// Routes 60 and 61 (P4 W4): the bell. `personal` rows for a Member or an Admin; the Inhouse team has no bell (OC 4), and
// the matrix keeps it off. The notices a person may see are the store's rule (server/notices/read.ts).
import { NotificationsListSchema, NotificationsReadInputSchema } from '../../shared/contract/notifications.ts'
import { apiJson } from '../http.ts'
import { readBody, readQuery, storesOf } from '../db/handler-kit.ts'
import type { ApiCtx } from '../db/handler-kit.ts'
import { renderNotice } from '../notices/render.ts'
import type { Viewer } from '../notices/read.ts'
import { z } from 'zod'

function viewer(c: ApiCtx): Viewer {
  const p = c.principal
  if (p.kind !== 'person') throw new Error('the bell is for members and Admins')
  // A `personal` row: the object is the person's own bell.
  c.access.requireObject({ ownerId: p.memberId })
  return { id: p.memberId, admin: p.role === 'admin' }
}

/** Route 60, `GET /api/notifications`: the 50 newest notices this person may see, with their read state. */
export async function listNotifications(c: ApiCtx): Promise<Response> {
  const query = readQuery(c.request, z.object({}).strict())
  if ('error' in query) return query.error
  const { rows, names } = await storesOf(c).notices.list(viewer(c))
  return apiJson(NotificationsListSchema.parse({ items: rows.map(r => renderNotice(r, names)) }))
}

/** Route 61, `POST /api/notifications/read` `{ ids }` (at most 100): marks the ones this person can see; the rest are skipped without an error. */
export async function markNotificationsRead(c: ApiCtx): Promise<Response> {
  const body = await readBody(c.request, NotificationsReadInputSchema)
  if ('error' in body) return body.error
  await storesOf(c).notices.markRead(viewer(c), body.ok.ids, c.nowMs)
  return apiJson({ ok: true })
}
