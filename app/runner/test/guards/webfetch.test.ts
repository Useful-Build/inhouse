// The WebFetch domain list. Ways it could fail, written first:
// - an empty list lets something through (the engine's preapproved documentation domains, say);
// - a host that only ends with, starts with or contains a listed domain passes (evil-example.com, example.com.evil);
// - a URL with credentials, an odd scheme, an IP or localhost passes;
// - case or a trailing dot lets a listed host fail, or an unlisted one pass;
// - the hook lets a call through on a malformed input instead of denying it.
import { fc, it } from '@fast-check/vitest'
import type { HookInput } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect } from 'vitest'
import { allowedFetchHost, webFetchAllowRules, webFetchHook } from '../../src/guards/webfetch.ts'

const label = fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,10}[a-z0-9])?$/)
// The top label starts with a letter: a numeric one (`a.3`) makes the URL parser read an IPv4 address, and the guards
// refuse such a domain in the run config (options.ts, assertFetchDomain).
const tld = fc.stringMatching(/^[a-z]([a-z0-9-]{0,10}[a-z0-9])?$/)
const domain = fc.tuple(label, tld).map(([a, b]) => `${a}.${b}`)

const call = (url: unknown): HookInput =>
  ({ hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url, prompt: 'x' }, tool_use_id: 't1', session_id: 's', transcript_path: '', cwd: '/work/a' }) as unknown as HookInput

async function decide(domains: string[], url: unknown) {
  const out = (await webFetchHook(domains).hooks[0]!(call(url), 't1', { signal: new AbortController().signal })) as {
    hookSpecificOutput?: { permissionDecision?: string }
  }
  return out.hookSpecificOutput?.permissionDecision ?? 'pass'
}

describe('WebFetch domains', () => {
  it.prop([fc.array(domain, { maxLength: 5 }), domain, fc.constantFrom('http', 'https'), fc.webPath()])(
    'a URL passes exactly when its host is listed',
    async (domains, host, scheme, path) => {
      const url = `${scheme}://${host}${path}`
      const listed = domains.includes(host)
      expect(allowedFetchHost(url, domains)).toBe(listed ? host : null)
      expect(await decide(domains, url)).toBe(listed ? 'pass' : 'deny')
    },
  )

  it.prop([fc.oneof(fc.webUrl(), fc.string(), fc.anything())])('an empty list denies everything', async (url) => {
    expect(allowedFetchHost(url, [])).toBeNull()
    expect(await decide([], url)).toBe('deny')
  })

  it('denies the preapproved documentation domains, near misses and tricks', async () => {
    expect(await decide([], 'https://docs.python.org/3/')).toBe('deny')
    const list = ['example.com']
    for (const url of [
      'https://evil-example.com/',
      'https://example.com.evil.net/',
      'https://sub.example.com/',
      'https://user:pw@example.com/',
      'https://example.com@evil.net/',
      'ftp://example.com/',
      'file:///etc/passwd',
      'http://127.0.0.1/',
      'http://localhost/',
      'not a url',
    ]) {
      expect(await decide(list, url), url).toBe('deny')
    }
    expect(await decide(list, 'https://EXAMPLE.com./a')).toBe('pass')
    expect(await decide(list, 'https://example.com:8443/a')).toBe('pass')
  })

  it('is a blocking WebFetch matcher, and its rules are one allow per domain', () => {
    const m = webFetchHook(['a.com'])
    expect(m.matcher).toBe('WebFetch')
    expect(m.onFailure).toBe('block')
    expect(webFetchAllowRules(['a.com', 'b.org'])).toEqual(['WebFetch(domain:a.com)', 'WebFetch(domain:b.org)'])
    expect(webFetchAllowRules([])).toEqual([])
  })
})
