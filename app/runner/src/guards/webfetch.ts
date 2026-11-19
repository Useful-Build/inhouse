// WebFetch reaches only the brand's listed domains (the run config's `webFetchDomains`), and nothing when the list is
// empty. Three layers:
// - permission rules: one `WebFetch(domain:<d>)` allow rule per listed domain, and `dontAsk` refuses the rest;
// - this hook: the engine lets a built-in set of documentation domains through without any rule, and an allow rule
//   can't be narrowed by a deny, so a PreToolUse hook refuses every URL whose host isn't listed exactly;
// - the network: the sandbox allowlist for Bash is the same list (sandbox.network in options.ts), and the container's
//   egress is the Worker's (W3).
import type { HookCallbackMatcher, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk'

/** The host of a URL a WebFetch call may fetch, or null when it may not (unlisted, not http(s), unreadable). */
export function allowedFetchHost(url: unknown, domains: readonly string[]): string | null {
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
  return domains.includes(host) ? host : null
}

const deny = (reason: string): HookJSONOutput => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
})

export function webFetchHook(domains: readonly string[]): HookCallbackMatcher {
  const listed = [...domains]
  return {
    matcher: 'WebFetch',
    onFailure: 'block',
    hooks: [
      async (input: HookInput) => {
        if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'WebFetch') return {}
        const url = (input.tool_input as { url?: unknown } | null)?.url
        if (allowedFetchHost(url, listed) !== null) return {}
        return deny(listed.length === 0 ? 'WebFetch is off for this brand: no domains are listed' : 'WebFetch can only reach the domains the brand listed')
      },
    ],
  }
}

/** The permission rules: one allow rule per listed domain. */
export function webFetchAllowRules(domains: readonly string[]): string[] {
  return domains.map((d) => `WebFetch(domain:${d})`)
}
