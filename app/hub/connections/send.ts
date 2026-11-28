// The one guarded way a request reaches a connection's servers (Stage 1 M4-R1, N35; #729). connectionCall's hops
// (call.ts), the object operations and revocation (hooks.ts) and the gateway-side hooks (M4-D's detect) all send
// through `sendHop`; none of them is handed the raw upstream. Each hop, in order:
// 1. a never-sent header (connections/headers.ts) refuses it: nothing is stripped silently;
// 2. the destination rule (destinations.ts): exactly one of the binding's addresses for the purpose, and a class that
//    purpose takes; with no binding yet (detect), only a request with no credential, to a URL that passes the static
//    address check;
// 3. the DNS half of the address check, the one await, given the request's signal;
// 4. the request's abort (its deadline, or the caller's) and the caller's own closed flag, read again after that await;
// 5. the caller's synchronous last check (call.ts: the record and `beforeCall`), then the send with no await between.
// `redirect: 'manual'` always: a 3xx comes back as an answer, never followed.
import type { ConnectionDestinations } from '../index/contract'
import type { Upstream } from '../oauth/http'
import { destinationRefusal, hostOf, staticRefusal, type CredentialClass, type DestinationPurpose, type DestinationRefusal, type ResolvePublic } from './destinations'
import { firstNeverSent } from './headers'

export type HopRefusal = DestinationRefusal | 'never_sent' | 'aborted' | 'stopped'

export type Hop = {
  /** The binding's destinations now, or null before there is one (detect). */
  destinations: ConnectionDestinations | null
  purpose: DestinationPurpose
  cls: CredentialClass
  resolvePublic: ResolvePublic
  base: Upstream
  /** True once the caller has its answer: a hop still waiting must then never leave. */
  closed?: () => boolean
  /** Synchronous, run right before the send: a refusal stops the hop. */
  lastCheck?: () => boolean
}

export type HopResult = { ok: true; response: Response } | { ok: false; refusal: HopRefusal }

/** The static half of a hop (steps 1 and 2): null when it may go on to the address check. */
export function hopStaticRefusal(hop: Pick<Hop, 'destinations' | 'purpose' | 'cls'>, request: Request): HopRefusal | null {
  if (firstNeverSent(request.headers) !== null) return 'never_sent'
  if (hop.destinations === null) return hop.cls !== 'none' ? 'class' : staticRefusal(request.url)
  return destinationRefusal(hop.destinations, hop.purpose, request.url, hop.cls)
}

/** One hop, steps 1 to 5. Never throws on a refusal; the upstream's own throw passes through. */
export async function sendHop(hop: Hop, request: Request): Promise<HopResult> {
  const refused = hopStaticRefusal(hop, request)
  if (refused) return { ok: false, refusal: refused }
  const body = request.body === null ? null : await request.clone().text()
  const isPublic = await hop.resolvePublic(hostOf(new URL(request.url)), request.signal)
  // ---- From here to the send: synchronous. ----
  if (hop.closed?.() || request.signal.aborted) return { ok: false, refusal: 'aborted' }
  if (!isPublic) return { ok: false, refusal: 'dns' }
  if (hop.lastCheck && !hop.lastCheck()) return { ok: false, refusal: 'stopped' }
  return { ok: true, response: await hop.base(new Request(request.url, { method: request.method, headers: request.headers, body: body !== null && body.length > 0 ? body : null, redirect: 'manual', signal: request.signal })) }
}

/** A sender for one request at a time (hooks.ts contexts): the same hop, built from plain parts. */
export type GuardedSend = (req: { purpose: DestinationPurpose; url: string; cls: CredentialClass; method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<HopResult>

/**
 * `bound`: the sender serves a connection (an operation, a revocation), so no binding (the record gone, or a built
 * connector's) refuses every request; unbound (detect) means only a credential-free request to a public address.
 */
export function guardedSender(o: { destinations: () => ConnectionDestinations | null; upstream: () => Promise<Upstream>; resolvePublic: ResolvePublic; bound: boolean }): GuardedSend {
  return async req => {
    const destinations = o.destinations()
    if (o.bound && destinations === null) return { ok: false, refusal: 'not_listed' }
    let request: Request
    try {
      request = new Request(req.url, { method: req.method, headers: req.headers ?? {}, body: req.body ?? null, redirect: 'manual', ...(req.signal ? { signal: req.signal } : {}) })
    } catch {
      return { ok: false, refusal: 'not_https' }
    }
    return sendHop({ destinations, purpose: req.purpose, cls: req.cls, resolvePublic: o.resolvePublic, base: await o.upstream() }, request)
  }
}
