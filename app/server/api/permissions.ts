// Routes 110 and 111 (Stage 1 M2-A, N10, N15): the "Always allow" permissions a person can see and remove. Members and
// Admins only (the matrix); the rule on the object is the store's, in its statement: a member sees and removes their own
// grants, an admin sees and removes any. No route creates a grant: "Always allow" is the outbox's answer (M2-B), and no
// route creates a brand grant in M2 (D4).
import { PermissionIdSchema, PermissionsListSchema, PermissionSchema, RemovePermissionInputSchema } from '../../shared/contract/permissions.ts'
import { readBody, readQuery, storesOf, writer } from '../db/handler-kit.ts'
import type { ApiCtx } from '../db/handler-kit.ts'
import { apiError, apiJson } from '../http.ts'
import type { Viewer } from '../permissions/grants.ts'
import { z } from 'zod'

/** The person asking. The matrix lets only brand people through; anything else is a wiring bug. */
function viewerOf(c: ApiCtx): Viewer {
  const p = c.principal
  if (p.kind !== 'person') throw new Error('permissions: only a brand person reaches these routes')
  return { memberId: p.memberId, role: p.role }
}

/** Route 110, `GET /api/permissions`: `{ items }`, newest first. */
export async function listPermissions(c: ApiCtx): Promise<Response> {
  const query = readQuery(c.request, z.object({}).strict())
  if ('error' in query) return query.error
  return apiJson(PermissionsListSchema.parse({ items: await storesOf(c).permissions.list(viewerOf(c)) }))
}

/**
 * Route 111, `POST /api/permissions/:id/remove` `{ ifRev }`: the viewer's list after the removal. 409 with `current`
 * when stale; 404 for an id the viewer can't see, or one already removed.
 */
export async function removePermission(c: ApiCtx): Promise<Response> {
  const id = PermissionIdSchema.safeParse(c.params.id)
  if (!id.success) return apiError('not_found')
  const body = await readBody(c.request, RemovePermissionInputSchema)
  if ('error' in body) return body.error
  const done = await storesOf(c).permissions.remove({ id: id.data, ifRev: body.ok.ifRev }, viewerOf(c), writer(c))
  if ('ok' in done) return apiJson(PermissionsListSchema.parse({ items: done.ok }))
  if ('conflict' in done) return apiError('conflict', { current: PermissionSchema.parse(done.conflict) })
  return apiError('not_found')
}
