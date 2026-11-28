// Where a credential may go (Stage 1 M4-R1, N35). Every sender asks this module before a request leaves: connectionCall
// (call.ts) on every hop, and the later senders (M4-D's probes, M4-O1a's sign-in legs, M4-B's check) through the same
// functions.
//
// The rule, by credential class (the binding's destinations are exact: scheme, host, port, path; no query or fragment):
// - a key or an access token goes only to `mcp`;
// - a client secret, a refresh token and a code go only to `token`;
// - a token being revoked, with the client's own credential, goes only to `revoke` (N35 names the endpoint and leaves
//   its class unsaid; RFC 7009 sends exactly that, and nowhere else may receive it);
// - nothing goes to `metadata`, `issuer`, `authorize` or `registration`: those are asked with no credential, ever.
// Every hop is https to a public address and never follows a redirect (oauth/http.ts `mcpFetch` and `send` both use
// `redirect: 'manual'`; a 3xx comes back with its Location removed). No caller's auth or forwarding header rides along.
// A changed metadata answer or endpoint never widens the binding: only a new prepare or a new confirm by the Inhouse
// team changes it (record.ts `rebound`, a new generation).
//
// The address check (the product's WebFetch rule, server/egress/ip.ts; p3-design 8.8): an address literal must be public;
// a name must be a DNS name of two or more labels, not `localhost`, and every A and AAAA answer from the pinned DNS over
// HTTPS resolver must be public. KNOWN LIMIT, as WebFetch's (decision 20): the platform's `fetch` resolves the name again,
// so the connection isn't pinned to the address the check approved (DNS to connect). The hub sets
// `global_fetch_strictly_public` (wrangler.hub.jsonc), so a name in the hub's own zone can't reach its origin directly.
// DNS over HTTPS JSON API (developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/,
// read 2026-11-28): `GET https://cloudflare-dns.com/dns-query?name=<n>&type=A|AAAA`, `accept: application/dns-json`;
// `Status` 0 is success; `Answer[]` carries a numeric `type` (1 A, 28 AAAA, 5 CNAME) and `data`.
import { addressVerdict } from '../../server/egress/ip'
import type { ConnectionDestinations } from '../index/contract'

/** What a request carries. `none`: no credential at all (metadata, discovery, an open server). */
export type CredentialClass = 'key' | 'access_token' | 'client_secret' | 'refresh_token' | 'code' | 'revocation' | 'none'
export type DestinationPurpose = keyof ConnectionDestinations

export const CREDENTIAL_CLASSES: readonly CredentialClass[] = ['key', 'access_token', 'client_secret', 'refresh_token', 'code', 'revocation', 'none']
export const PURPOSES: readonly DestinationPurpose[] = ['mcp', 'metadata', 'issuer', 'authorize', 'token', 'registration', 'revoke']

/** The one purpose each credential class may reach. `none` may reach any of them. */
const ALLOWED: Record<Exclude<CredentialClass, 'none'>, DestinationPurpose> = {
  key: 'mcp',
  access_token: 'mcp',
  client_secret: 'token',
  refresh_token: 'token',
  code: 'token',
  revocation: 'revoke',
}

export const purposeAllows = (purpose: DestinationPurpose, cls: CredentialClass): boolean => cls === 'none' || ALLOWED[cls] === purpose

export type DestinationRefusal = 'not_https' | 'not_listed' | 'class' | 'address' | 'dns'

/** The binding's addresses for one purpose. */
function addressesFor(d: ConnectionDestinations, purpose: DestinationPurpose): string[] {
  const v = d[purpose]
  if (Array.isArray(v)) return [...v]
  return v === null ? [] : [v]
}

/** A DNS name of two or more labels (letters, digits, hyphens; no label starting or ending with a hyphen), not localhost. */
function dnsName(host: string): boolean {
  if (host.length > 253 || host === 'localhost' || host.endsWith('.localhost')) return false
  const labels = host.split('.')
  if (labels.length < 2) return false
  if (/^[0-9]+$/.test(labels[labels.length - 1]!)) return false
  return labels.every(l => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))
}

/** A URL's host as the checks see it: lower case, one trailing dot dropped, brackets of an IPv6 literal removed. */
export const hostOf = (url: URL): string => url.hostname.replace(/\.$/, '').toLowerCase().replace(/^\[(.*)\]$/, '$1')

/**
 * The static half of the address check: https, no user part or fragment, and a public address literal or a DNS name.
 * Null when it passes. A name still needs `resolvesPublic` before a request leaves.
 */
export function staticRefusal(raw: string): DestinationRefusal | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'not_https'
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') return 'not_https'
  const host = hostOf(url)
  const literal = addressVerdict(host)
  if (literal === 'blocked') return 'address'
  if (literal === 'public') return null
  return dnsName(host) ? null : 'address'
}

/**
 * The destination rule for one request (synchronous): `url` is exactly one of the binding's addresses for `purpose`, that
 * purpose takes `cls`, and the address passes the static check. Null when the request may go (after `resolvesPublic`).
 */
export function destinationRefusal(d: ConnectionDestinations, purpose: DestinationPurpose, url: string, cls: CredentialClass): DestinationRefusal | null {
  const s = staticRefusal(url)
  if (s) return s
  if (!purposeAllows(purpose, cls)) return 'class'
  // Exact: the same URL (both read as WHATWG URLs, so `https://h/x` is `https://h:443/x`), never a prefix, another
  // path, port or scheme, or another purpose's address.
  const href = new URL(url).href
  return addressesFor(d, purpose).some(a => hrefOf(a) === href) ? null : 'not_listed'
}

/** A stored address as a WHATWG URL's `href` (its one spelling), or null when it doesn't parse. */
export function hrefOf(raw: string): string | null {
  try {
    return new URL(raw).href
  } catch {
    return null
  }
}

/**
 * A binding prepare may record: every address passes the static check (none names a private address), and each address
 * that receives a credential (`mcp`, `token`, `revoke`) is no other purpose's, so a credential sent to its own purpose
 * can't land on an address the binding also lists for another.
 */
export function bindingRefusal(d: ConnectionDestinations): { purpose: DestinationPurpose; refusal: DestinationRefusal | 'shared' } | null {
  for (const purpose of PURPOSES) {
    for (const url of addressesFor(d, purpose)) {
      const r = staticRefusal(url)
      if (r) return { purpose, refusal: r }
    }
  }
  for (const purpose of ['mcp', 'token', 'revoke'] as const) {
    for (const url of addressesFor(d, purpose)) {
      const href = hrefOf(url)
      if (PURPOSES.some(other => other !== purpose && addressesFor(d, other).some(a => hrefOf(a) === href))) return { purpose, refusal: 'shared' }
    }
  }
  return null
}

export const DOH_URL = 'https://cloudflare-dns.com/dns-query'
/** One DNS over HTTPS answer: at most this long (both lookups together) and this many bytes each. */
export const DOH_TIMEOUT_MS = 5_000
export const DOH_MAX_BYTES = 64 * 1024

/**
 * A host's DNS verdict: true only when it has at least one A or AAAA answer and every one of them is public. `signal`:
 * the request this check is for; when it aborts, the lookup stops and answers false.
 */
export type ResolvePublic = (host: string, signal?: AbortSignal) => Promise<boolean>

/**
 * The DNS half (the product's WebFetch `resolvesPublic`, the same resolver and rule), with its own deadline (a timer
 * cleared when it settles, never AbortSignal.timeout), the caller's signal, and a byte cap on each answer. Never throws:
 * a failure, a timeout or an abort is false.
 */
export function dohResolver(f: (req: Request) => Promise<Response>, bounds: { timeoutMs?: number; maxBytes?: number } = {}): ResolvePublic {
  const timeoutMs = bounds.timeoutMs ?? DOH_TIMEOUT_MS
  const maxBytes = bounds.maxBytes ?? DOH_MAX_BYTES
  return async (host, signal) => {
    const literal = addressVerdict(host)
    if (literal !== null) return literal === 'public'
    if (!dnsName(host)) return false
    if (signal?.aborted) return false
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new DOMException('dns deadline', 'TimeoutError')), timeoutMs)
    const onOuter = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onOuter, { once: true })
    // Raced against the abort, so a resolver that ignores its signal still can't hold the check past the deadline.
    const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    aborted.catch(() => undefined)
    try {
      let any = false
      for (const type of ['A', 'AAAA']) {
        const res = await Promise.race([f(new Request(`${DOH_URL}?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: 'application/dns-json' }, redirect: 'manual', signal: controller.signal })), aborted])
        if (!res.ok) return false
        const text = await Promise.race([cappedText(res, maxBytes), aborted])
        if (text === null) return false
        const body = JSON.parse(text) as { Status?: unknown; Answer?: { type?: unknown; data?: unknown }[] }
        if (body.Status !== 0) return false
        for (const a of Array.isArray(body.Answer) ? body.Answer : []) {
          if (a.type !== 1 && a.type !== 28) continue
          if (typeof a.data !== 'string' || addressVerdict(a.data) !== 'public') return false
          any = true
        }
      }
      return any
    } catch {
      return false
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onOuter)
    }
  }
}

/** A body read to at most `maxBytes` (null past it, or on a broken or non-UTF-8 body). */
async function cappedText(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const all = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(all)
  } catch {
    return null
  }
}
