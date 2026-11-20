// The chat socket (P3, p3-design sections 3 and 4.10): route 34, the WebSocket upgrade. Owner: W1 (p3-w1.md). P2's path
// has already authenticated the caller (401 without a valid sign-in), checked the upgrade's `Origin` and the row. This
// handler names who the socket is for in `x-inhouse-principal` (any copy the request brought is dropped: only the
// fields set here reach the object) and hands the upgrade to the BrandAgent, which holds the socket (sockets.ts).
// Every attach is checked there against the run's owner, so a person's or the smoke member's socket is their own
// object (`requireObject` with themselves, like a list); Inhouse needs a live grant.
import { apiError } from '../http.ts'
import { brandAgent } from '../do/brand-agent/client.ts'
import { PRINCIPAL_HEADER } from '../do/brand-agent/sockets.ts'
import type { SocketPrincipal } from '../do/brand-agent/sockets.ts'
import type { Handler, HandlerContext } from '../routes.ts'

/** Who the socket is for, or the refusal. */
function socketPrincipal(c: HandlerContext): SocketPrincipal | Response {
  const p = c.principal
  if (p.kind === 'person') {
    c.access.requireObject({ ownerId: p.memberId })
    return { kind: 'person', memberId: p.memberId, role: p.role, grantId: null, grantEndsAtMs: null, expMs: p.expMs, requestId: p.requestId }
  }
  if (p.kind === 'inhouse') {
    if (!p.grant || p.grant.endsAtMs <= c.nowMs) return apiError('forbidden', { reason: 'grant_required' })
    return { kind: 'inhouse', memberId: p.memberId, role: null, grantId: p.grant.id, grantEndsAtMs: p.grant.endsAtMs, expMs: p.expMs, requestId: p.requestId }
  }
  if (p.kind === 'service' && p.name === 'smoke') {
    c.access.requireObject({ ownerId: p.memberId })
    return { kind: 'smoke', memberId: p.memberId, role: null, grantId: null, grantEndsAtMs: null, expMs: null, requestId: p.requestId }
  }
  return apiError('forbidden')
}

/** Route 34, `GET /api/socket?v=` (upgrade). A plain GET is 400: this route only upgrades. */
export const openSocket: Handler = async (c: HandlerContext) => {
  if (c.request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return apiError('invalid')
  const who = socketPrincipal(c)
  if (who instanceof Response) return who
  // A new request with only what the object reads: the upgrade, the version in the URL, and the principal set here.
  const headers = new Headers({ Upgrade: 'websocket', [PRINCIPAL_HEADER]: JSON.stringify(who) })
  return brandAgent(c.env).fetch(new Request(c.request.url, { method: 'GET', headers }))
}
