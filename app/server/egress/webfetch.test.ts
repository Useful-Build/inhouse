// WebFetch (p3-design 8.8 and 6.2, decision 20) against a fake network: a fake DoH resolver and fake pages. Ways it can
// fail, written down first:
//  1. a private, loopback, link-local, CGNAT, metadata, multicast, reserved or IPv4-mapped address passes, as a DNS
//     answer (even one among public ones) or as a literal;
//  2. an empty list, or none stored, lets any host through (P8a S: empty means no host); a list lets an unlisted host
//     through or refuses a listed public one;
//  3. a redirect to an unlisted host or a private address is followed; more than 3 hops are followed;
//  4. a method other than GET or HEAD, a port other than 443 or plain http passes;
//  5. cookies or authorization reach the site; a body over 10 MB comes back whole.
import { fc, it as prop } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { addressVerdict } from './ip.ts'
import { checkUrl, handleWebFetch, WEBFETCH_MAX_BYTES } from './webfetch.ts'

type Dns = Record<string, { A?: string[]; AAAA?: string[]; status?: number }>

function net(dns: Dns, pages: Record<string, () => Response>) {
  const fetched: { url: string; headers: Headers }[] = []
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.origin === 'https://cloudflare-dns.com') {
      const name = url.searchParams.get('name')!
      const type = url.searchParams.get('type') as 'A' | 'AAAA'
      const rec = dns[name]
      if (!rec) return Response.json({ Status: 3 })
      return Response.json({ Status: rec.status ?? 0, Answer: [{ name, type: 5, data: 'alias.example.' }, ...(rec[type] ?? []).map(data => ({ name, type: type === 'A' ? 1 : 28, data }))] })
    }
    fetched.push({ url: url.href, headers: new Headers(init?.headers) })
    const page = pages[url.href]
    return page ? page() : new Response('nope', { status: 404 })
  }) as typeof fetch
  return { f, fetched }
}

const PUBLIC_DNS: Dns = {
  'docs.example.com': { A: ['93.184.216.34'], AAAA: ['2606:2800:220:1::1'] },
  'other.example.org': { A: ['198.41.0.4'] },
  'sneaky.example.com': { A: ['93.184.216.34', '10.0.0.7'] },
  'v6private.example.com': { AAAA: ['fd00:ec2::254'] },
  'mapped.example.com': { AAAA: ['::ffff:127.0.0.1'] },
  'meta.example.com': { A: ['169.254.169.254'] },
  'dual.example.com': { A: ['93.184.216.34'], AAAA: ['fd00:ec2::254'] },
}
/** Every name PUBLIC_DNS knows, and one it doesn't: the address checks run on listed hosts. */
const ALL = [...Object.keys(PUBLIC_DNS), 'missing.example.com'].join('\n')
const page = (body = 'hello') => () => new Response(body, { headers: { 'content-type': 'text/html', 'set-cookie': 'tracker=1', server: 'x' } })

async function run(url: string, opts: { list?: string | null; method?: string; headers?: Record<string, string>; pages?: Record<string, () => Response>; dns?: Dns } = {}) {
  const { f, fetched } = net(opts.dns ?? PUBLIC_DNS, opts.pages ?? { 'https://docs.example.com/a': page(), 'https://other.example.org/b': page() })
  const logs: Record<string, unknown>[] = []
  const res = await handleWebFetch(new Request(url, { method: opts.method ?? 'GET', headers: opts.headers }), { hostList: async () => opts.list ?? null, fetch: f, log: e => void logs.push(e) })
  return { res, fetched, logs }
}

describe('addresses (failure 1)', () => {
  it('refuses every non-public range, v4, v6 and mapped; passes public ones', () => {
    const blocked = [
      '0.0.0.0', '10.1.2.3', '100.64.0.1', '100.127.255.254', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255',
      '192.0.0.8', '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.51.100.2', '203.0.113.9', '224.0.0.1', '239.255.255.250',
      '240.0.0.1', '255.255.255.255',
      '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:8.8.8.8', '64:ff9b::808:808', 'fc00::1', 'fd00:ec2::254', 'fe80::1',
      'fec0::1', 'ff02::1', '2001:db8::1', '2001::1', '2002:7f00:1::', '3fff::1', '100::1', '::127.0.0.1', '[::1]',
    ]
    for (const a of blocked) expect(addressVerdict(a), a).toBe('blocked')
    for (const a of ['8.8.8.8', '93.184.216.34', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '2a00:1450::1']) expect(addressVerdict(a), a).toBe('public')
    expect(addressVerdict('docs.example.com')).toBeNull()
  })
})

describe('an empty list, or none stored: no host (P8a S, failure 2)', () => {
  it('refuses every host, public ones included, before any lookup or fetch', async () => {
    for (const list of [null, '']) {
      for (const url of ['https://docs.example.com/a', 'https://other.example.org/b', 'https://example.com/']) {
        const { res, fetched, logs } = await run(url, { list })
        expect(res.status, `${String(list)} ${url}`).toBe(403)
        expect(await res.text()).toBe('WebFetch refused: not_listed')
        expect(fetched, url).toEqual([])
        expect(logs).toEqual([{ event: 'webfetch_refused', why: 'not_listed' }])
      }
    }
  })
})

describe('listed hosts: every address check still runs (6.2, decision 20)', () => {
  it('fetches a public host, without cookies, authorization or the response cookie', async () => {
    const { res, fetched } = await run('https://docs.example.com/a', { list: ALL, headers: { cookie: 'a=1', authorization: 'Bearer x', accept: 'text/html' } })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hello')
    expect([...res.headers]).toEqual([['content-type', 'text/html']])
    expect([...fetched[0]!.headers]).toEqual([['accept', 'text/html']])
  })
  it('refuses a private answer, one private answer among public ones, a public A with a private AAAA, IPv6 unique-local, mapped and metadata', async () => {
    for (const host of ['dual.example.com', 'sneaky.example.com', 'v6private.example.com', 'mapped.example.com', 'meta.example.com', 'missing.example.com']) {
      const { res, fetched } = await run(`https://${host}/x`, { list: ALL })
      expect(res.status, host).toBe(403)
      expect(fetched, host).toEqual([])
    }
  })
  it('refuses IP literals in private ranges, a non-443 port, plain http and POST', async () => {
    for (const url of ['https://127.0.0.1/x', 'https://[::1]/x', 'https://169.254.169.254/latest', 'https://0x7f.1/x', 'https://docs.example.com:8443/a', 'http://docs.example.com/a']) {
      const { res, fetched } = await run(url, { list: ALL })
      expect(res.status, url).toBe(403)
      expect(fetched, url).toEqual([])
    }
    const post = await run('https://docs.example.com/a', { list: ALL, method: 'POST' })
    expect(post.res.status).toBe(405)
    expect(post.fetched).toEqual([])
  })
  it('a redirect to a private address is refused; a public one is followed and re-checked', async () => {
    const pages = {
      'https://docs.example.com/a': () => new Response(null, { status: 302, headers: { location: 'https://meta.example.com/latest' } }),
      'https://docs.example.com/b': () => new Response(null, { status: 301, headers: { location: '/c' } }),
      'https://docs.example.com/c': page('moved'),
    }
    const bad = await run('https://docs.example.com/a', { list: ALL, pages })
    expect(bad.res.status).toBe(403)
    expect(bad.fetched.map(f => f.url)).toEqual(['https://docs.example.com/a'])
    const good = await run('https://docs.example.com/b', { list: ALL, pages })
    expect(await good.res.text()).toBe('moved')
  })
  it('at most 3 redirects', async () => {
    const pages: Record<string, () => Response> = {}
    for (let i = 0; i < 5; i++) pages[`https://docs.example.com/r${i}`] = () => new Response(null, { status: 302, headers: { location: `/r${i + 1}` } })
    const { res, fetched } = await run('https://docs.example.com/r0', { list: ALL, pages })
    expect(res.status).toBe(403)
    expect(fetched).toHaveLength(4)
  })
})

describe('a non-empty list: exactly those hosts', () => {
  it('fetches a listed host; refuses an unlisted public host and a redirect to one', async () => {
    const list = 'docs.example.com'
    expect((await run('https://docs.example.com/a', { list })).res.status).toBe(200)
    const unlisted = await run('https://other.example.org/b', { list })
    expect(unlisted.res.status).toBe(403)
    expect(unlisted.fetched).toEqual([])
    const pages = { 'https://docs.example.com/a': () => new Response(null, { status: 302, headers: { location: 'https://other.example.org/b' } }) }
    const hop = await run('https://docs.example.com/a', { list, pages })
    expect(hop.res.status).toBe(403)
    expect(hop.fetched.map(f => f.url)).toEqual(['https://docs.example.com/a'])
  })
  it('a listed host still gets every address check', async () => {
    const r = await run('https://sneaky.example.com/x', { list: 'sneaky.example.com' })
    expect(r.res.status).toBe(403)
    expect(r.fetched).toEqual([])
    expect((await run('https://docs.example.com/a', { list: 'not a list!' })).res.status).toBe(403)
  })
})

describe('size (failure 5)', () => {
  it('a declared length over 10 MB is refused; an undeclared one is cut at 10 MB', async () => {
    const declared = await run('https://docs.example.com/a', { list: ALL, pages: { 'https://docs.example.com/a': () => new Response('x', { headers: { 'content-length': String(WEBFETCH_MAX_BYTES + 1) } }) } })
    expect(declared.res.status).toBe(403)
    const chunk = new Uint8Array(1024 * 1024)
    const endless = () => new Response(new ReadableStream({ pull: c => c.enqueue(chunk) }))
    const { res } = await run('https://docs.example.com/a', { list: ALL, pages: { 'https://docs.example.com/a': endless } })
    const reader = res.body!.getReader()
    let got = 0
    await expect((async () => {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        got += value.byteLength
      }
    })()).rejects.toThrow()
    expect(got).toBeLessThanOrEqual(WEBFETCH_MAX_BYTES)
  })
})

// Failure 2 as a property: over random host lists and random https URLs (on a network where every name resolves to one
// public address), a URL passes the checks exactly when its host is on the list; an empty list passes none.
const LABEL = fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,8}[a-z0-9])?$/)
const HOST = fc.tuple(fc.array(LABEL, { minLength: 1, maxLength: 3 }), fc.constantFrom('com', 'org', 'test', 'io')).map(([ls, tld]) => [...ls, tld].join('.'))
const everyNamePublic = (async (input: RequestInfo | URL) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  const type = url.searchParams.get('type')
  return Response.json({ Status: 0, Answer: [{ type: type === 'A' ? 1 : 28, data: type === 'A' ? '93.184.216.34' : '2606:2800:220:1::1' }] })
}) as typeof fetch

describe('the list decides (property, failure 2)', () => {
  prop.prop([fc.uniqueArray(HOST, { maxLength: 6 }), fc.oneof(HOST, fc.constantFrom('docs.example.com')), fc.boolean(), fc.webPath()])(
    'a URL is allowed only when its host is listed', async (list, other, pickListed, path) => {
      const host = pickListed && list.length > 0 ? list[0]! : other
      const why = await checkUrl(new URL(`https://${host}${path}`), list, everyNamePublic)
      expect(why).toBe(list.includes(host) ? null : 'not_listed')
    },
  )
  prop.prop([fc.uniqueArray(HOST, { minLength: 1, maxLength: 6 }), LABEL])(
    'exact hosts only: a subdomain of a listed host, and the parent of one, are not listed', async (list, label) => {
      const listed = list[0]!
      const sub = `${label}.${listed}`
      if (!list.includes(sub)) expect(await checkUrl(new URL(`https://${sub}/x`), list, everyNamePublic)).toBe('not_listed')
      // The parent of a listed host: only the subdomain is on the list.
      expect(await checkUrl(new URL(`https://${listed}/x`), [sub], everyNamePublic)).toBe('not_listed')
    },
  )
  prop.prop([fc.uniqueArray(HOST, { minLength: 1, maxLength: 6 }), fc.constantFrom('A', 'B')])(
    'a listed host passes in any case and with a trailing dot', async (list, variant) => {
      const host = variant === 'A' ? list[0]!.toUpperCase() : `${list[0]!}.`
      expect(await checkUrl(new URL(`https://${host}/x`), list, everyNamePublic)).toBeNull()
    },
  )
})
