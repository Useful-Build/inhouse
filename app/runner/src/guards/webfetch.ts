// WebFetch's reach (the run config's `webFetchDomains`; Wasim, decision 20: on from the start):
// - `null`: any public host, on the scheme's default port. Each URL's host is still refused here when it's an IP
//   literal, a local name (`localhost`, `*.local`, `*.internal`, ...), this container's own address or a reserved label
//   (options.ts, fetchHostRefusal), and, best effort, when the name resolves here to a loopback, private, link-local,
//   CGNAT or other reserved address or to this container (`127.0.0.1.nip.io`). Best effort only: DNS can answer
//   differently between this check and the fetch, and a failed or slow lookup lets the call through. The real check is
//   the Worker egress's (design 8.8); a fetch pinned to the checked address is a P3 "Later" item;
// - a list: only those hosts, exactly;
// - `[]`: none.
// Three layers:
// - permission rules: a bare `WebFetch` allow rule (null) or one `WebFetch(domain:<d>)` per listed domain, and
//   `dontAsk` refuses the rest;
// - this hook: the engine lets a built-in set of documentation domains through without any rule, and an allow rule
//   can't be narrowed by a deny, so a PreToolUse hook decides every URL itself;
// - the network: the sandbox allowlist for Bash is the list (none with null: options.ts), and the container's egress is
//   the Worker's (W3).
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { HookCallbackMatcher, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk'
import { fetchHostRefusal } from './options.ts'

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
    // The scheme's default port only (the URL parser drops an explicit default, so any port left is another one).
    if (parsed.port !== '') return null
    return fetchHostRefusal(host, hostAddresses) === null ? host : null
  }
  return domains.includes(host) ? host : null
}

const deny = (reason: string): HookJSONOutput => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
})

/**
 * Best effort: whether `host` resolves to a reserved address or this container's own. A failed or slow lookup is
 * `false` (the Worker's egress still checks).
 */
export async function resolvesToReserved(host: string, own: readonly string[], resolve: Resolve, timeoutMs = RESOLVE_TIMEOUT_MS): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    const addresses = await Promise.race([resolve(host), new Promise<null>((r) => (timer = setTimeout(() => r(null), timeoutMs)))])
    return addresses !== null && addresses.some((a) => reservedAddress(a) || own.includes(a))
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export function webFetchHook(domains: readonly string[] | null, hostAddresses: readonly string[] = [], resolve: Resolve = systemResolve): HookCallbackMatcher {
  const listed = domains === null ? null : [...domains]
  const own = [...hostAddresses]
  return {
    matcher: 'WebFetch',
    onFailure: 'block',
    hooks: [
      async (input: HookInput) => {
        if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'WebFetch') return {}
        const url = (input.tool_input as { url?: unknown } | null)?.url
        const host = allowedFetchHost(url, listed, own)
        if (host !== null && (listed !== null || !(await resolvesToReserved(host, own, resolve)))) return {}
        if (listed === null) return deny('WebFetch reaches public web addresses only: not an IP address, a local or private address, another port or this container')
        return deny(listed.length === 0 ? 'WebFetch is off for this brand: no domains are listed' : 'WebFetch can only reach the domains the brand listed')
      },
    ],
  }
}

/** The permission rules: any domain (null; the hook narrows it), or one allow rule per listed domain. */
export function webFetchAllowRules(domains: readonly string[] | null): string[] {
  return domains === null ? ['WebFetch'] : domains.map((d) => `WebFetch(domain:${d})`)
}
