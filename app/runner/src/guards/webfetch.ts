// WebFetch's reach (the run config's `webFetchDomains`; Wasim, decision 20: on from the start):
// - `null`: any public host. Each URL's host is still refused here when it's an IP literal, a local name
//   (`localhost`, `*.local`, `*.internal`, ...), this container's own address or a reserved label (options.ts,
//   fetchHostRefusal); a public name that resolves to a private or reserved address is the Worker's egress to refuse
//   (design 8.8, best effort);
// - a list: only those hosts, exactly;
// - `[]`: none.
// Three layers:
// - permission rules: a bare `WebFetch` allow rule (null) or one `WebFetch(domain:<d>)` per listed domain, and
//   `dontAsk` refuses the rest;
// - this hook: the engine lets a built-in set of documentation domains through without any rule, and an allow rule
//   can't be narrowed by a deny, so a PreToolUse hook decides every URL itself;
// - the network: the sandbox allowlist for Bash is the list (none with null: options.ts), and the container's egress is
//   the Worker's (W3).
import type { HookCallbackMatcher, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk'
import { fetchHostRefusal } from './options.ts'

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
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (domains === null) return fetchHostRefusal(host, hostAddresses) === null ? host : null
  return domains.includes(host) ? host : null
}

const deny = (reason: string): HookJSONOutput => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
})

export function webFetchHook(domains: readonly string[] | null, hostAddresses: readonly string[] = []): HookCallbackMatcher {
  const listed = domains === null ? null : [...domains]
  const own = [...hostAddresses]
  return {
    matcher: 'WebFetch',
    onFailure: 'block',
    hooks: [
      async (input: HookInput) => {
        if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'WebFetch') return {}
        const url = (input.tool_input as { url?: unknown } | null)?.url
        if (allowedFetchHost(url, listed, own) !== null) return {}
        if (listed === null) return deny('WebFetch reaches public web addresses only: not an IP address, a local name or this container')
        return deny(listed.length === 0 ? 'WebFetch is off for this brand: no domains are listed' : 'WebFetch can only reach the domains the brand listed')
      },
    ],
  }
}

/** The permission rules: any domain (null; the hook narrows it), or one allow rule per listed domain. */
export function webFetchAllowRules(domains: readonly string[] | null): string[] {
  return domains === null ? ['WebFetch'] : domains.map((d) => `WebFetch(domain:${d})`)
}
