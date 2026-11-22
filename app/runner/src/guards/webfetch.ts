// WebFetch's reach (the run config's `webFetchDomains`; Wasim, decision 20: on from the start):
// - `null`: any public host, on port 443 only (design 8.8): an https URL with no port or `:443`; plain http (port 80)
//   and any other port are refused. Each URL's host is still refused here when it's an IP
//   literal, a local name (`localhost`, `*.local`, `*.internal`, ...), this container's own address or a reserved label
//   (options.ts, fetchHostRefusal), and, best effort, when the name resolves here to a loopback, private, link-local,
//   CGNAT or other reserved address or to this container (`127.0.0.1.nip.io`). Best effort only: DNS can answer
//   differently between this check and the fetch, and a failed or slow lookup lets the call through. The real check is
//   the Worker egress's (design 8.8); a fetch pinned to the checked address is a P3 "Later" item. In our container the
//   lookup can't see the real address at all: started with `enableInternet: false` and a `*` HTTPS intercept
//   (server/do/runner/runner.ts), "A and AAAA lookups for an intercepted hostname return a placeholder address that
//   routes the request to the intercept", and a `*` target makes "every hostname resolve, including hostnames that do not
//   exist" (https://developers.cloudflare.com/durable-objects/api/container/, read 2026-11-21). So the check first asks
//   for a fresh random name under example.com that real DNS has no record for; what it answers is the intercept's
//   placeholder set (the sandbox: fd00::119:1 and an IPv4 address). A host whose every answer is in that set reaches
//   the intercept, so the egress's own DoH check decides it and the lookup's verdict is skipped (it would refuse every
//   public host). Any other answer is judged as before, so a resolver that rewrites a name to 127.0.0.1 is still
//   refused. Not `.invalid`: the platform resolver has no answer for that special-use name;
// - a list: only those hosts, exactly;
// - `[]`: none.
// Three layers:
// - permission rules: a bare `WebFetch` allow rule (null) or one `WebFetch(domain:<d>)` per listed domain, and
//   `dontAsk` refuses the rest;
// - this hook: the engine lets a built-in set of documentation domains through without any rule, and an allow rule
//   can't be narrowed by a deny, so a PreToolUse hook decides every URL itself;
// - the network: the sandbox allowlist for Bash is the list (none with null: options.ts), and the container's egress is
//   the Worker's (W3).
import { randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { HookCallbackMatcher, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk'
import { WEBFETCH_DENY } from '../../../shared/protocol/webfetch-denials.ts'
import { fetchHostRefusal } from './options.ts'

/**
 * A name real DNS has no record for: a fresh random label under example.com (IANA's documentation domain, which has no
 * wildcard; the label is neutral, so nothing about the product reaches an outside resolver), fully qualified (the trailing dot skips search domains). Whatever it resolves to
 * is a placeholder every name gets (the container intercept's). A fresh label per probe, so no cache anywhere can
 * answer it from an earlier lookup.
 */
export const dnsProbeHost = (): string => `dns-probe-${randomBytes(6).toString('hex')}.example.com.`
/** The most resolved addresses a deny reason lists. */
export const DENY_ADDRESSES_MAX = 4

/** Resolves a name to its addresses (all families). */
export type Resolve = (host: string) => Promise<string[]>
export const systemResolve: Resolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address)
/** How long the best-effort lookup may take before the call goes through unchecked. */
export const RESOLVE_TIMEOUT_MS = 2000

const v4 = (ip: string) => ip.split('.').map(Number)
/**
 * An address WebFetch must never reach: unspecified, loopback, private (RFC 1918, unique local), link-local, CGNAT
 * (100.64/10), benchmark (198.18/15), IETF protocol (192.0.0/24), multicast and reserved, and IPv4 inside IPv6
 * (mapped, NAT64) by its IPv4 part.
 */
export function reservedAddress(ip: string): boolean {
  const kind = isIP(ip)
  if (kind === 4) {
    const [a, b, c] = v4(ip) as [number, number, number, number]
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19))
    )
  }
  if (kind !== 6) return true
  const g = v6Groups(ip)
  if (g === null) return true
  const v4of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d): judged by their IPv4 part.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return reservedAddress(v4of(g[6]!, g[7]!))
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return reservedAddress(v4of(g[6]!, g[7]!))
  if (g.slice(0, 7).every((x) => x === 0) && (g[7] === 0 || g[7] === 1)) return true
  const first = g[0]!
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00
}

/** An IPv6 address as its eight 16-bit groups (a trailing dotted IPv4 part included), or null when it isn't one. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, '')
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (dotted) {
    const [a, b, c, d] = v4(dotted[1]!) as [number, number, number, number]
    s = s.slice(0, -dotted[1]!.length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const part = (h: string) => (h === '' ? [] : h.split(':').map((x) => parseInt(x, 16)))
  const head = part(halves[0]!)
  const tail = halves.length === 2 ? part(halves[1]!) : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  const groups = [...head, ...Array<number>(Math.max(0, fill)).fill(0), ...tail]
  return groups.length === 8 && groups.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? groups : null
}

/**
 * The host of a URL a WebFetch call may fetch, or null when it may not (unlisted, or with `domains` null a host
 * `fetchHostRefusal` refuses; not http(s); credentials; unreadable).
 */
export function allowedFetchHost(url: unknown, domains: readonly string[] | null, hostAddresses: readonly string[] = []): string | null {
  if (typeof url !== 'string') return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  // Credentials in the URL are never needed to read a public page.
  if (parsed.username !== '' || parsed.password !== '') return null
  // One trailing dot is the same name; more than one, or an empty label anywhere, is no name WebFetch reaches.
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (host.split('.').some((label) => label === '')) return null
  if (domains === null) {
    // Port 443 only (design 8.8): https, with no port or `:443` (the URL parser drops it, so any port left is another).
    if (parsed.protocol !== 'https:' || parsed.port !== '') return null
    return fetchHostRefusal(host, hostAddresses) === null ? host : null
  }
  return domains.includes(host) ? host : null
}

/** Addresses for a deny reason: zone ids dropped, this container's own named only as such, capped. */
function shown(addresses: readonly string[], own: readonly string[]): string {
  const names = [...new Set(addresses.map((a) => (own.includes(a) ? 'an own address' : a.replace(/%.*$/, ''))))]
  return `${names.slice(0, DENY_ADDRESSES_MAX).join(', ')}${names.length > DENY_ADDRESSES_MAX ? ', ...' : ''}`
}

const deny = (reason: string): HookJSONOutput => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
})

/** The lookup's answer within `timeoutMs`, or null when it fails or is slow. */
async function lookupWithin(host: string, resolve: Resolve, timeoutMs: number): Promise<string[] | null> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([resolve(host), new Promise<null>((r) => (timer = setTimeout(() => r(null), timeoutMs)))])
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Best effort: the reserved or own addresses `host` resolves to (empty when none, or when the lookup fails or is slow:
 * the Worker's egress still checks).
 */
export async function reservedResolution(host: string, own: readonly string[], resolve: Resolve, timeoutMs = RESOLVE_TIMEOUT_MS): Promise<string[]> {
  const addresses = await lookupWithin(host, resolve, timeoutMs)
  return addresses === null ? [] : addresses.filter((a) => reservedAddress(a) || own.includes(a))
}

/** Best effort: whether `host` resolves to a reserved address or this container's own. */
export async function resolvesToReserved(host: string, own: readonly string[], resolve: Resolve, timeoutMs = RESOLVE_TIMEOUT_MS): Promise<boolean> {
  return (await reservedResolution(host, own, resolve, timeoutMs)).length > 0
}

/** What the probe name resolves to (null: no record, a failure or too slow): the placeholders every name gets, if any. */
export async function probeDns(resolve: Resolve, timeoutMs = RESOLVE_TIMEOUT_MS): Promise<string[] | null> {
  return lookupWithin(dnsProbeHost(), resolve, timeoutMs)
}

/**
 * An address no placeholder may stand for, whatever the probe got: loopback (127/8, ::1), link-local (169.254/16,
 * fe80::/10), RFC 1918 IPv4 (10/8, 172.16/12, 192.168/16), IPv4 inside IPv6 by its IPv4 part, and this container's
 * own. A resolver that rewrites every name to one of these is judged, never skipped.
 */
export function neverPlaceholder(ip: string, own: readonly string[]): boolean {
  if (own.includes(ip)) return true
  const kind = isIP(ip)
  if (kind === 4) {
    const [a, b] = v4(ip) as [number, number, number, number]
    return a === 127 || a === 10 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  const g = kind === 6 ? v6Groups(ip) : null
  if (g === null) return true
  const v4of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return neverPlaceholder(v4of(g[6]!, g[7]!), own)
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true
  return (g[0]! & 0xffc0) === 0xfe80
}

/**
 * Whether every one of a host's answers is a placeholder the probe got (so the host reaches the intercept), and none is
 * an address a placeholder may never stand for.
 */
export const onlyPlaceholders = (answers: readonly string[], placeholders: ReadonlySet<string>, own: readonly string[]): boolean =>
  answers.length > 0 && answers.every((a) => placeholders.has(a) && !neverPlaceholder(a, own))

/**
 * `onDeny`: called with the call before a deny goes back, and awaited (options.ts records a 'deny' audit entry with it);
 * if it throws, the hook throws and `onFailure: 'block'` blocks the call, so a deny is never lost to a call that runs.
 */
export function webFetchHook(domains: readonly string[] | null, hostAddresses: readonly string[] = [], resolve: Resolve = systemResolve,
  onDeny?: (input: HookInput & { hook_event_name: 'PreToolUse' }) => Promise<void>): HookCallbackMatcher {
  const listed = domains === null ? null : [...domains]
  const own = [...hostAddresses]
  // The probe's answers, kept only when there are some (real DNS has none, and is asked again each time). A host's
  // answers outside the kept set ask the probe again, in case the placeholders changed, before they're judged.
  let placeholders: ReadonlySet<string> | null = null
  const reservedHere = async (host: string): Promise<{ reserved: string[]; answers: string[]; probe: string[] | null }> => {
    const answers = await lookupWithin(host, resolve, RESOLVE_TIMEOUT_MS)
    // A failed or slow lookup lets the call through (best effort: the egress still checks).
    if (answers === null) return { reserved: [], answers: [], probe: null }
    if (placeholders !== null && onlyPlaceholders(answers, placeholders, own)) return { reserved: [], answers, probe: null }
    const probe = await probeDns(resolve)
    // Only replaced by another non-empty answer: a slower probe that failed can't drop what a concurrent one saw.
    if (probe !== null && probe.length > 0) placeholders = new Set(probe)
    if (placeholders !== null && onlyPlaceholders(answers, placeholders, own)) return { reserved: [], answers, probe }
    return { reserved: answers.filter((a) => reservedAddress(a) || own.includes(a)), answers, probe }
  }
  return {
    matcher: 'WebFetch',
    onFailure: 'block',
    hooks: [
      async (input: HookInput) => {
        if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'WebFetch') return {}
        const out = await decide(input)
        if (out.hookSpecificOutput?.permissionDecision === 'deny' && onDeny) await onDeny(input)
        return out
      },
    ],
  }
  /** The hook's decision for one WebFetch call: `{}` to let it go, or a deny. */
  async function decide(input: HookInput & { hook_event_name: 'PreToolUse' }): Promise<HookJSONOutput & { hookSpecificOutput?: { permissionDecision?: string } }> {
    const url = (input.tool_input as { url?: unknown } | null)?.url
    const host = allowedFetchHost(url, listed, own)
    if (host !== null && listed !== null) return {}
    const { reserved, answers, probe } = host === null ? { reserved: [], answers: [], probe: null } : await reservedHere(host)
    if (host !== null && reserved.length === 0) return {}
    // What the synthetic-DNS probe got and what a public name resolved to here (both capped), probe first, so a run's
    // visible refusal shows why the check ran. With a probe answer, every one of the host's answers, so a mismatch
    // with the placeholders shows; without, its reserved ones.
    if (listed === null) {
      if (reserved.length === 0) return deny(WEBFETCH_DENY.publicOnly)
      const probed = probe !== null && probe.length > 0
      return deny(`${WEBFETCH_DENY.publicOnly} (probe: ${probed ? shown(probe, own) : 'none'}; ${host} resolved here to ${shown(probed ? answers : reserved, own)})`)
    }
    return deny(listed.length === 0 ? WEBFETCH_DENY.off : WEBFETCH_DENY.notListed)
  }
}

/** The permission rules: any domain (null; the hook narrows it), or one allow rule per listed domain. */
export function webFetchAllowRules(domains: readonly string[] | null): string[] {
  return domains === null ? ['WebFetch'] : domains.map((d) => `WebFetch(domain:${d})`)
}
