// The destination rule (connections/destinations.ts, Stage 1 M4-R1, N35) as a property. Ways it could go wrong, written
// first: a key or a token accepted at a metadata, issuer, authorize or registration address (N53's plant: "a key sent to
// a metadata address"); a refresh token or a code at the MCP address; an address matched by prefix, by host alone, or
// over http; a private address literal passed; a binding where one address serves two purposes, so a credential sent to
// its own purpose lands on another's.
import { describe, expect, it } from 'vitest'
import { fc, test } from '@fast-check/vitest'
import type { ConnectionDestinations } from '../index/contract'
import { bindingRefusal, CREDENTIAL_CLASSES, destinationRefusal, dohResolver, hrefOf, PURPOSES, purposeAllows, staticRefusal, type CredentialClass, type DestinationPurpose } from './destinations'

/** Where each class may go: the one rule, written out again here as the oracle. */
const ORACLE: Record<Exclude<CredentialClass, 'none'>, DestinationPurpose> = { key: 'mcp', access_token: 'mcp', client_secret: 'token', refresh_token: 'token', code: 'token', revocation: 'revoke' }

const HOSTS = ['mcp.example.com', 'login.example.com', 'meta.example.net']
const PATHS = ['/mcp', '/token', '/.well-known/oauth-protected-resource', '/authorize', '/register', '/revoke', '/', '/mcp/']
const arbAddress = fc.tuple(fc.constantFrom(...HOSTS), fc.constantFrom('', ':8443'), fc.constantFrom(...PATHS)).map(([h, p, path]) => `https://${h}${p}${path}`)
const arbDestinations: fc.Arbitrary<ConnectionDestinations> = fc.record({
  mcp: arbAddress,
  metadata: fc.array(arbAddress, { maxLength: 3 }),
  issuer: fc.option(arbAddress, { nil: null }),
  authorize: fc.option(arbAddress, { nil: null }),
  token: fc.option(arbAddress, { nil: null }),
  registration: fc.option(arbAddress, { nil: null }),
  revoke: fc.option(arbAddress, { nil: null }),
})
/** A request URL: one of the binding's own, or a near miss of one (another scheme, port, path, a query, a fragment). */
const arbUrl = (d: ConnectionDestinations) => {
  const own = PURPOSES.flatMap(p => (Array.isArray(d[p]) ? (d[p] as string[]) : d[p] === null ? [] : [d[p] as string]))
  return fc.oneof(
    fc.constantFrom(...own),
    fc.constantFrom(...own).chain(u => fc.constantFrom(u.replace('https:', 'http:'), `${u}x`, `${u}?a=1`, `${u}#f`, u.replace('.com', '.com.evil.net'), u.replace('https://', 'https://user:pw@'), u.endsWith('/') ? u.slice(0, -1) : `${u}/`)),
    arbAddress,
  )
}
const addressesOf = (d: ConnectionDestinations, p: DestinationPurpose) => (Array.isArray(d[p]) ? (d[p] as string[]) : d[p] === null ? [] : [d[p] as string]).map(hrefOf)

describe('the destination rule', () => {
  test.prop([arbDestinations.chain(d => fc.tuple(fc.constant(d), arbUrl(d), fc.constantFrom(...CREDENTIAL_CLASSES), fc.constantFrom(...PURPOSES))) ], { numRuns: 2000 })(
    'no credential class ever reaches another purpose\'s address, an address not listed, or http',
    ([d, url, cls, purpose]) => {
      const verdict = destinationRefusal(d, purpose, url, cls)
      if (verdict !== null) return
      const href = hrefOf(url)
      expect(url.startsWith('https://')).toBe(true)
      expect(addressesOf(d, purpose)).toContain(href)
      if (cls === 'none') return
      // Whatever purpose the sender named, a credential lands only on its own class's address.
      expect(purpose).toBe(ORACLE[cls])
      // And a binding prepare accepts never lists that address for any other purpose.
      if (bindingRefusal(d) === null) for (const other of PURPOSES) if (other !== ORACLE[cls]) expect(addressesOf(d, other)).not.toContain(href)
    },
  )

  it('every class but none has exactly one purpose; nothing credentialed goes to metadata, issuer, authorize or registration', () => {
    for (const cls of CREDENTIAL_CLASSES) {
      const allowed = PURPOSES.filter(p => purposeAllows(p, cls))
      expect(allowed, cls).toEqual(cls === 'none' ? PURPOSES : [ORACLE[cls as Exclude<CredentialClass, 'none'>]])
    }
    for (const p of ['metadata', 'issuer', 'authorize', 'registration'] as const) {
      expect(CREDENTIAL_CLASSES.filter(c => purposeAllows(p, c))).toEqual(['none'])
    }
  })

  it('a key named for the mcp purpose at a metadata address is refused (the plant: "a key sent to a metadata address")', () => {
    const d: ConnectionDestinations = { mcp: 'https://mcp.example.com/mcp', metadata: ['https://mcp.example.com/.well-known/oauth-protected-resource'], issuer: null, authorize: null, token: null, registration: null, revoke: null }
    expect(destinationRefusal(d, 'metadata', d.metadata[0]!, 'key')).toBe('class')
    expect(destinationRefusal(d, 'mcp', d.metadata[0]!, 'key')).toBe('not_listed')
    expect(destinationRefusal(d, 'mcp', d.mcp, 'key')).toBeNull()
  })

  it('a binding that lists one address for a credential purpose and another purpose is refused at prepare', () => {
    const shared = 'https://login.example.com/token'
    expect(bindingRefusal({ mcp: 'https://mcp.example.com/mcp', metadata: [shared], issuer: null, authorize: null, token: shared, registration: null, revoke: null })).toEqual({ purpose: 'token', refusal: 'shared' })
    expect(bindingRefusal({ mcp: 'https://mcp.example.com/mcp', metadata: [], issuer: null, authorize: null, token: shared, registration: null, revoke: null })).toBeNull()
  })
})

describe('the address check', () => {
  it('http, a user part, a fragment, a private or reserved literal and a non-DNS name are refused before anything is sent', () => {
    for (const u of ['http://mcp.example.com/mcp', 'https://u:p@mcp.example.com/mcp', 'https://mcp.example.com/mcp#x', 'https://10.0.0.7/mcp', 'https://127.0.0.1/mcp', 'https://169.254.169.254/latest', 'https://[::1]/mcp', 'https://[fd00:ec2::254]/', 'https://localhost/mcp', 'https://intranet/mcp', 'https://a.localhost/mcp', 'https://0x7f.1/mcp', 'https://2130706433/mcp', 'not a url']) {
      expect(staticRefusal(u), u).not.toBeNull()
    }
    for (const u of ['https://mcp.example.com/mcp', 'https://mcp.example.com:8443/x', 'https://8.8.8.8/mcp', 'https://[2606:4700::1111]/mcp']) expect(staticRefusal(u), u).toBeNull()
  })

  it('DNS: every A and AAAA answer must be public, and there must be one; a failed lookup is a refusal', async () => {
    const answers: Record<string, { Status: number; Answer?: { type: number; data: string }[] }> = {
      'pub.example.com|A': { Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] },
      'pub.example.com|AAAA': { Status: 0, Answer: [] },
      'rebind.example.com|A': { Status: 0, Answer: [{ type: 5, data: 'x.example.com.' }, { type: 1, data: '93.184.216.34' }, { type: 1, data: '10.0.0.7' }] },
      'rebind.example.com|AAAA': { Status: 0, Answer: [] },
      'six.example.com|A': { Status: 0, Answer: [] },
      'six.example.com|AAAA': { Status: 0, Answer: [{ type: 28, data: 'fd00::1' }] },
      'none.example.com|A': { Status: 0, Answer: [] },
      'none.example.com|AAAA': { Status: 0, Answer: [] },
      'nx.example.com|A': { Status: 3 },
    }
    const asked: string[] = []
    const resolve = dohResolver(async req => {
      const u = new URL(req.url)
      expect(u.origin + u.pathname).toBe('https://cloudflare-dns.com/dns-query')
      const key = `${u.searchParams.get('name')}|${u.searchParams.get('type')}`
      asked.push(key)
      const a = answers[key]
      return a ? Response.json(a) : new Response('no', { status: 500 })
    })
    expect(await resolve('pub.example.com')).toBe(true)
    expect(await resolve('rebind.example.com')).toBe(false)
    expect(await resolve('six.example.com')).toBe(false)
    expect(await resolve('none.example.com')).toBe(false)
    expect(await resolve('nx.example.com')).toBe(false)
    expect(await resolve('down.example.com')).toBe(false)
    expect(await resolve('10.0.0.7')).toBe(false)
    expect(await resolve('8.8.8.8')).toBe(true)
    // Literals and non-names never ask the resolver.
    expect(asked.some(k => k.startsWith('10.') || k.startsWith('8.8'))).toBe(false)
    const throwing = dohResolver(async () => {
      throw new TypeError('network')
    })
    expect(await throwing('pub.example.com')).toBe(false)
  })
})

describe('the DNS lookup is bounded (Neon round 1, #2; #732)', () => {
  const json = (a: unknown) => Response.json(a)

  it('a public A with a private AAAA is refused: both lookups are read', async () => {
    const resolve = dohResolver(async req => {
      const type = new URL(req.url).searchParams.get('type')
      return json(type === 'A' ? { Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] } : { Status: 0, Answer: [{ type: 28, data: 'fd00::7' }] })
    })
    expect(await resolve('mixed.example.com')).toBe(false)
  })

  it('a resolver that never answers is refused at the deadline, whatever its signal handling', async () => {
    const resolve = dohResolver(() => new Promise<Response>(() => undefined), { timeoutMs: 20 })
    expect(await resolve('stall.example.com')).toBe(false)
  })

  it('an answer past the byte cap is refused', async () => {
    const big = JSON.stringify({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }], pad: 'x'.repeat(2048) })
    const resolve = dohResolver(async () => new Response(big), { maxBytes: 1024 })
    expect(await resolve('big.example.com')).toBe(false)
    const fits = dohResolver(async req => json(new URL(req.url).searchParams.get('type') === 'A' ? { Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] } : { Status: 0, Answer: [] }), { maxBytes: 1024 })
    expect(await fits('small.example.com')).toBe(true)
  })

  it('the caller\'s abort stops the lookup: false, and the resolver saw the abort', async () => {
    const controller = new AbortController()
    let sawAbort = false
    const resolve = dohResolver(req => new Promise<Response>((_, reject) => req.signal.addEventListener('abort', () => ((sawAbort = true), reject(new Error('aborted'))))))
    const pending = resolve('slow.example.com', controller.signal)
    controller.abort()
    expect(await pending).toBe(false)
    expect(sawAbort).toBe(true)
    expect(await resolve('slow.example.com', controller.signal)).toBe(false)
  })
})
