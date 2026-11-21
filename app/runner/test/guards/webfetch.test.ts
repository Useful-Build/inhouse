// The WebFetch domain list. Ways it could fail, written first:
// - an empty list lets something through (the engine's preapproved documentation domains, say);
// - a host that only ends with, starts with or contains a listed domain passes (evil-example.com, example.com.evil);
// - a URL with credentials, an odd scheme, an IP or localhost passes;
// - case or a trailing dot lets a listed host fail, or an unlisted one pass;
// - the hook lets a call through on a malformed input instead of denying it;
// - with WebFetch open to any public host (null, decision 20), a public host is refused, or an IP literal (any form),
//   `localhost`, a `.local`/`.internal` name, this container's own host or a reserved label passes; a list doesn't
//   narrow it, or `[]` lets anything through;
// - in our container (no Internet, a `*` HTTPS intercept: every name resolves to the intercept's placeholder) the
//   best-effort DNS check refuses every public host (Q2 on the sandbox: example.com refused; then a `.invalid` probe the
//   platform resolver NXDOMAINs never fired), or skipping it there also
//   drops the name, IP and port checks; the skip covers a host with any answer the probe didn't get (a rewritten
//   127.0.0.1); a deny for a reserved resolution doesn't say what DNS (and the probe) answered.
import { fc, it } from '@fast-check/vitest'
import type { HookInput } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect } from 'vitest'
import { WEBFETCH_DENY } from '../../../shared/protocol/webfetch-denials.ts'
import { allowedFetchHost, reservedAddress, resolvesToReserved, webFetchAllowRules, webFetchHook, type Resolve } from '../../src/guards/webfetch.ts'

// No `--` in the third and fourth places: those labels are reserved, and the URL parser refuses an `xn--` one that
// isn't valid punycode (`xn--a`), so no URL could be built from it.
const plain = (l: string) => !/^.{2}--/.test(l)
const label = fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,10}[a-z0-9])?$/).filter(plain)
// The top label starts with a letter: a numeric one (`a.3`) makes the URL parser read an IPv4 address, and the guards
// refuse such a domain in the run config (options.ts, assertFetchDomain).
const tld = fc.stringMatching(/^[a-z]([a-z0-9-]{0,10}[a-z0-9])?$/).filter(plain)
const domain = fc.tuple(label, tld).map(([a, b]) => `${a}.${b}`)

const call = (url: unknown): HookInput =>
  ({ hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url, prompt: 'x' }, tool_use_id: 't1', session_id: 's', transcript_path: '', cwd: '/work/a' }) as unknown as HookInput

async function decide(domains: string[], url: unknown) {
  const out = (await webFetchHook(domains).hooks[0]!(call(url), 't1', { signal: new AbortController().signal })) as {
    hookSpecificOutput?: { permissionDecision?: string }
  }
  return out.hookSpecificOutput?.permissionDecision ?? 'pass'
}

const OWN = ['10.0.0.7', 'runner-host.example', '203.0.113.7']
/** A resolver over a literal table (no network): unknown names resolve to a public documentation address. */
const DNS: Record<string, string[]> = {
  '127.0.0.1.nip.io': ['127.0.0.1'],
  'ten.example': ['10.1.2.3'],
  'cgnat.example': ['100.64.0.9'],
  'linklocal.example': ['169.254.169.254'],
  'v6local.example': ['fe80::1'],
  'mapped.example': ['::ffff:127.0.0.1'],
  'ula.example': ['fd00::5'],
  'self.example': ['203.0.113.7'],
  'mixed.example': ['93.184.216.34', '192.168.1.1'],
}
/** The synthetic-DNS probe's name: a fresh random label under example.com, fully qualified. */
const PROBE = /^dns-probe-[0-9a-f]{12}\.example\.com\.$/
const isProbe = (h: string) => PROBE.test(h)
/** Real DNS: example.com has no wildcard, so the probe's random name has no record (Node: ENOTFOUND) and the probe reads no. */
const fakeResolve: Resolve = async (host) => {
  if (isProbe(host)) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' })
  return DNS[host] ?? ['93.184.216.34']
}
async function decideOpen(url: unknown, resolve: Resolve = fakeResolve) {
  return (await reasonOpen(url, resolve)).decision
}
async function reasonOpen(url: unknown, resolve: Resolve = fakeResolve, hook = webFetchHook(null, OWN, resolve)) {
  const out = (await hook.hooks[0]!(call(url), 't1', { signal: new AbortController().signal })) as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string }
  }
  return { decision: out.hookSpecificOutput?.permissionDecision ?? 'pass', reason: out.hookSpecificOutput?.permissionDecisionReason }
}

describe('WebFetch open to any public host (null)', () => {
  it.each(['https://example.com:443/', 'https://example.com/a?b=c', 'https://example.com./'])('%s passes (https on 443, one trailing dot)', async (url) => {
    expect(await decideOpen(url)).toBe('pass')
  })

  it.each(['127.0.0.1.nip.io', 'ten.example', 'cgnat.example', 'linklocal.example', 'v6local.example', 'mapped.example', 'ula.example', 'self.example', 'mixed.example'])(
    'a name resolving to a reserved address or this container is refused: %s',
    async (host) => {
      expect(await decideOpen(`https://${host}/`)).toBe('deny')
    },
  )

  it('best effort: a lookup that fails or hangs lets the call through (the Worker egress checks)', async () => {
    expect(await decideOpen('https://example.com/', async () => Promise.reject(new Error('ENOTFOUND')))).toBe('pass')
    expect(await resolvesToReserved('example.com', OWN, () => new Promise<string[]>(() => {}), 10)).toBe(false)
    expect(await resolvesToReserved('127.0.0.1.nip.io', OWN, fakeResolve, 10)).toBe(true)
  })

  it('a deny for a reserved resolution says what DNS answered here, capped at 4 addresses', async () => {
    const many: Resolve = async (h) => (isProbe(h) ? Promise.reject(new Error('ENOTFOUND')) : ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5', '93.184.216.34'])
    expect(await reasonOpen('https://mixed.example/')).toEqual({ decision: 'deny', reason: `${WEBFETCH_DENY.publicOnly} (probe: none; mixed.example resolved here to 192.168.1.1)` })
    expect(await reasonOpen('https://many.example/', many)).toEqual({ decision: 'deny', reason: `${WEBFETCH_DENY.publicOnly} (probe: none; many.example resolved here to 10.0.0.1, 10.0.0.2, 10.0.0.3, 10.0.0.4, ...)` })
    const four: Resolve = async (h) => (isProbe(h) ? Promise.reject(new Error('ENOTFOUND')) : ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'])
    expect(await reasonOpen('https://four.example/', four)).toEqual({ decision: 'deny', reason: `${WEBFETCH_DENY.publicOnly} (probe: none; four.example resolved here to 10.0.0.1, 10.0.0.2, 10.0.0.3, 10.0.0.4)` })
    // The container's own address is named only as such; a zone id is dropped.
    expect(await reasonOpen('https://self.example/')).toEqual({ decision: 'deny', reason: `${WEBFETCH_DENY.publicOnly} (probe: none; self.example resolved here to an own address)` })
    const zoned: Resolve = async (h) => (isProbe(h) ? Promise.reject(new Error('ENOTFOUND')) : ['fe80::1%eth0'])
    expect(await reasonOpen('https://zoned.example/', zoned)).toEqual({ decision: 'deny', reason: `${WEBFETCH_DENY.publicOnly} (probe: none; zoned.example resolved here to fe80::1)` })
    // The probe's own answers go through the same cap and masking: more than 4, one of them an own address, one zoned.
    const noisyProbe: Resolve = async (h) => (isProbe(h) ? ['fe80::2%eth0', '203.0.113.7', '10.9.0.1', '10.9.0.2', '10.9.0.3', '198.51.100.10'] : fakeResolve(h))
    expect(await reasonOpen('https://127.0.0.1.nip.io/', noisyProbe)).toEqual({ decision: 'deny', reason: `${WEBFETCH_DENY.publicOnly} (probe: fe80::2, an own address, 10.9.0.1, 10.9.0.2, ...; 127.0.0.1.nip.io resolved here to 127.0.0.1)` })
    // A refusal by name, IP or port keeps the plain reason (nothing was resolved).
    expect(await reasonOpen('https://127.0.0.1/')).toEqual({ decision: 'deny', reason: WEBFETCH_DENY.publicOnly })
  })

  // Our container's DNS (durable-objects/api/container docs): with a `*` intercept every name resolves, to a placeholder
  // address that routes to the intercept, including names that don't exist. The placeholder is the one the sandbox showed
  // (`example.com resolved here to fd00::119:1`, a unique local address).
  const intercepted: Resolve = async () => ['fd00::119:1']

  it('in the container (synthetic DNS: the random example.com probe resolves to the placeholder) a public host passes', async () => {
    expect(await decideOpen('https://example.com/', intercepted)).toBe('pass')
    expect(await decideOpen('https://127.0.0.1.nip.io/', intercepted)).toBe('pass')
  })

  it("the sandbox's resolver: special-use names (.invalid) NXDOMAIN, every other name the placeholder; example.com passes", async () => {
    const platform: Resolve = async (h) => (/\.(invalid|test|localhost)\.?$/.test(h) ? Promise.reject(new Error('ENOTFOUND')) : ['fd00::119:1'])
    expect(await reasonOpen('https://example.com/', platform)).toEqual({ decision: 'pass', reason: undefined })
  })

  it('in the container the name, IP and port checks still refuse', async () => {
    for (const url of ['https://127.0.0.1/', 'https://[::1]/', 'https://localhost/', 'https://db.internal/', 'https://example.com:8443/', 'http://example.com/', 'https://runner-host.example/']) {
      expect([url, await decideOpen(url, intercepted)]).toEqual([url, 'deny'])
    }
  })

  it("the probe's placeholders are kept: a host answered only with them asks no probe again", async () => {
    const probes: string[] = []
    const logging: Resolve = async (h) => (isProbe(h) && probes.push(h), intercepted(h))
    const hook = webFetchHook(null, OWN, logging)
    expect((await reasonOpen('https://example.com/', logging, hook)).decision).toBe('pass')
    expect((await reasonOpen('https://example.org/', logging, hook)).decision).toBe('pass')
    expect(probes).toHaveLength(1)
    expect(probes[0]).toMatch(PROBE)
  })

  // The sandbox (fleet 65dc7ed): the probe resolved to the ULA placeholder and an IPv4 address our classifier calls
  // public, so "every probe answer reserved" never held. The rule now: a host whose every answer is a probe answer.
  const sandbox: Resolve = async (h) => (isProbe(h) || h === 'example.com' ? ['fd00::119:1', '11.0.0.9'] : h === 'v6only.example' ? ['fd00::119:1'] : fakeResolve(h))

  it('the sandbox shape: the probe answers a ULA and an IPv4 placeholder; a host answered with them (or a subset) passes', async () => {
    const hook = webFetchHook(null, OWN, sandbox)
    expect(await reasonOpen('https://example.com/', sandbox, hook)).toEqual({ decision: 'pass', reason: undefined })
    expect(await reasonOpen('https://v6only.example/', sandbox, hook)).toEqual({ decision: 'pass', reason: undefined })
  })

  it("a host with any answer outside the probe's set is judged as before: 127.0.0.1.nip.io, or a placeholder plus 127.0.0.1", async () => {
    const extra: Resolve = async (h) => (h === 'extra.example' ? ['fd00::119:1', '127.0.0.1'] : sandbox(h))
    expect(await reasonOpen('https://127.0.0.1.nip.io/', sandbox)).toEqual({ decision: 'deny', reason: `${WEBFETCH_DENY.publicOnly} (probe: fd00::119:1, 11.0.0.9; 127.0.0.1.nip.io resolved here to 127.0.0.1)` })
    expect(await reasonOpen('https://extra.example/', extra)).toEqual({ decision: 'deny', reason: `${WEBFETCH_DENY.publicOnly} (probe: fd00::119:1, 11.0.0.9; extra.example resolved here to fd00::119:1, 127.0.0.1)` })
  })

  it('placeholders that change are picked up: an answer outside the kept set asks the probe again', async () => {
    let placeholder = 'fd00::119:1'
    const moving: Resolve = async () => [placeholder]
    const hook = webFetchHook(null, OWN, moving)
    expect((await reasonOpen('https://example.com/', moving, hook)).decision).toBe('pass')
    placeholder = 'fd00::119:2'
    expect((await reasonOpen('https://example.com/', moving, hook)).decision).toBe('pass')
  })

  it('under real DNS each probe asks a fresh random name', async () => {
    const probes: string[] = []
    const logging: Resolve = async (h) => (isProbe(h) && probes.push(h), fakeResolve(h))
    const hook = webFetchHook(null, OWN, logging)
    expect((await reasonOpen('https://example.com/', logging, hook)).decision).toBe('pass')
    expect((await reasonOpen('https://example.org/', logging, hook)).decision).toBe('pass')
    expect(probes).toHaveLength(2)
    expect(probes[0]).not.toBe(probes[1])
  })

  it('a probe answered with a reserved and a public address does not cover a host answered with neither', async () => {
    const mixedProbe: Resolve = async (h) => (isProbe(h) ? ['fd00::119:1', '198.51.100.10'] : fakeResolve(h))
    expect(await reasonOpen('https://127.0.0.1.nip.io/', mixedProbe)).toEqual({ decision: 'deny', reason: `${WEBFETCH_DENY.publicOnly} (probe: fd00::119:1, 198.51.100.10; 127.0.0.1.nip.io resolved here to 127.0.0.1)` })
  })

  it('a resolver that answers the probe with a public address (NXDOMAIN hijacking): a name it rewrites to 127.0.0.1 is still refused', async () => {
    const hijacking: Resolve = async (h) => (isProbe(h) ? ['198.51.100.10'] : fakeResolve(h))
    expect(await reasonOpen('https://127.0.0.1.nip.io/', hijacking)).toEqual({ decision: 'deny', reason: `${WEBFETCH_DENY.publicOnly} (probe: 198.51.100.10; 127.0.0.1.nip.io resolved here to 127.0.0.1)` })
    expect(await decideOpen('https://example.com/', hijacking)).toBe('pass')
  })

  it('a listed domain is not resolved (the brand chose it)', async () => {
    let asked = 0
    const out = (await webFetchHook(['ten.example'], OWN, async (h) => (asked++, fakeResolve(h))).hooks[0]!(call('https://ten.example/'), 't1', { signal: new AbortController().signal })) as {
      hookSpecificOutput?: { permissionDecision?: string }
    }
    expect(out.hookSpecificOutput?.permissionDecision ?? 'pass').toBe('pass')
    expect(asked).toBe(0)
  })

  it.each([
    ['0.0.0.0', true], ['10.0.0.1', true], ['100.63.255.255', false], ['100.64.0.0', true], ['100.127.255.255', true], ['100.128.0.0', false],
    ['127.0.0.1', true], ['169.254.1.1', true], ['172.15.255.255', false], ['172.16.0.1', true], ['172.31.255.255', true], ['172.32.0.0', false],
    ['192.0.0.8', true], ['192.168.0.1', true], ['198.18.0.1', true], ['198.20.0.1', false], ['224.0.0.1', true], ['255.255.255.255', true],
    ['93.184.216.34', false], ['8.8.8.8', false],
    ['::', true], ['::1', true], ['fc00::1', true], ['fdff::1', true], ['fe80::1', true], ['febf::1', true], ['ff02::1', true],
    ['::ffff:10.0.0.1', true], ['::ffff:93.184.216.34', false], ['::ffff:7f00:1', true], ['::ffff:5db8:d822', false], ['64:ff9b::7f00:1', true], ['64:ff9b::127.0.0.1', true], ['0:0:0:0:0:0:0:1', true],
    ['2606:4700::1111', false], ['not an ip', true],
  ])('reservedAddress(%s) is %s', (ip, reserved) => {
    expect(reservedAddress(ip as string)).toBe(reserved)
  })

  it.prop([domain, fc.constantFrom('http', 'https'), fc.webPath()])('a public host passes over https (443), never over http', async (host, scheme, path) => {
    const url = `${scheme}://${host}${path}`
    expect(allowedFetchHost(url, null, OWN)).toBe(scheme === 'https' ? host : null)
    expect(await decideOpen(url)).toBe(scheme === 'https' ? 'pass' : 'deny')
  })

  it.each([
    'http://127.0.0.1/',
    'http://10.0.0.7/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://0x7f.1/',
    'http://2130706433/',
    'http://localhost:8080/',
    'http://LOCALHOST./',
    'http://printer.local/',
    'http://egress.internal/events/',
    'http://db.svc/',
    'http://intranet/',
    'https://runner-host.example/',
    'https://xn--a-ecp.example/',
    'https://user:pw@example.com/',
    'ftp://example.com/',
    // Another port than the scheme's.
    'https://example.com:8443/',
    'http://example.com:443/',
    // Port 443 only (design 8.8): plain http is port 80.
    'http://example.com/',
    'http://example.com:80/',
    // Empty labels (two trailing dots, or one in the middle).
    'https://example.com../',
    'https://example..com/',
    'not a url',
    42,
  ])('%s is still refused', async (url) => {
    expect(allowedFetchHost(url, null, OWN)).toBeNull()
    expect(await decideOpen(url)).toBe('deny')
  })

  it('the permission rule is a bare WebFetch; a list narrows to its domains; [] allows none', async () => {
    expect(webFetchAllowRules(null)).toEqual(['WebFetch'])
    expect(webFetchAllowRules(['docs.example.com'])).toEqual(['WebFetch(domain:docs.example.com)'])
    expect(webFetchAllowRules([])).toEqual([])
    expect(await decide(['docs.example.com'], 'https://other.example.com/')).toBe('deny')
    expect(await decide(['docs.example.com'], 'https://docs.example.com/a')).toBe('pass')
    expect(await decide([], 'https://docs.example.com/a')).toBe('deny')
  })
})

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
