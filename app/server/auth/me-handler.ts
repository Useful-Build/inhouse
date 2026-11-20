// `GET /api/me` (route 2, p2-design section 11): who is signed in and what they may do. `can` comes from the same
// access-matrix rows `checkAccess` reads, so the UI never offers what the server refuses.
import type { Me } from '../../shared/contract/me.ts'
import { photoUrl } from '../db/photos.ts'
import { apiError, apiJson } from '../http.ts'
import type { Handler } from '../routes.ts'
import { canFor } from './matrix.ts'
import type { AccessRow, CanRows } from './matrix.ts'
import type { MemberPrincipal } from './principal.ts'
import type { AuthStores } from './stores.ts'

/** `Me` for a principal with a member row and its profile. */
export function buildMe(principal: MemberPrincipal, profile: { name: string; email: string | null; photoKey: string | null }, rows: readonly AccessRow[], canRows: CanRows, nowMs: number): Me {
  const role = principal.kind === 'inhouse' ? 'inhouse' : principal.kind === 'person' ? principal.role : 'member'
  const grant = principal.kind === 'inhouse' && principal.grant && principal.grant.endsAtMs > nowMs
    ? { id: principal.grant.id, endsAt: { iso: new Date(principal.grant.endsAtMs).toISOString(), ms: principal.grant.endsAtMs } }
    : null
  return {
    memberId: principal.memberId,
    name: profile.name,
    email: profile.email,
    role,
    can: canFor(principal, rows, canRows, nowMs),
    photoUrl: profile.photoKey ? photoUrl(principal.memberId, profile.photoKey) : null,
    grant,
  }
}

/**
 * The route's handler, given the committed rows and their `CanRows` (server/routes.ts wires it). It reads the stores
 * and the clock from its context: `nowMs` is the request's one clock, so `can` and `grant` match what api.ts decided.
 */
export function meHandler(deps: { rows: readonly AccessRow[]; canRows: CanRows }): Handler {
  return async ({ principal, requestId, nowMs, stores }) => {
    // monitor and release have no member row (and no row 2 entry: checkAccess refuses them first).
    if (principal.kind === 'service' && principal.name !== 'smoke') return apiError('forbidden')
    if (!stores) throw new Error('GET /api/me has no stores: its row must not be a report row')
    let profile: Awaited<ReturnType<AuthStores['members']['profile']>>
    try {
      profile = await stores.members.profile(principal.memberId)
    } catch (err) {
      console.error({ event: 'me_profile_failed', requestId, error: err instanceof Error ? err.name : 'unknown' })
      return apiError('unavailable')
    }
    if (!profile) {
      console.error({ event: 'me_without_member_row', requestId })
      return apiError('unknown')
    }
    return apiJson(buildMe(principal, profile, deps.rows, deps.canRows, nowMs))
  }
}
