// WebFetch (p3-design 8.8 and 6.2, decision 20) against a fake network: a fake DoH resolver and fake pages. Ways it can
// fail, written down first:
//  1. a private, loopback, link-local, CGNAT, metadata, multicast, reserved or IPv4-mapped address passes, as a DNS
//     answer (even one among public ones) or as a literal;
//  2. an empty list, or none stored, lets any host through (P8a S: empty means no host); a list lets an unlisted host
//     through or refuses a listed public one;
//  3. a redirect to an unlisted host or a private address is followed; more than 3 hops are followed;
//  4. a method other than GET or HEAD, a port other than 443 or plain http passes;
//  5. cookies or authorization reach the site; a body over 10 MB comes back whole;
//  6. (P8a, the egress record) a request goes out unrecorded, a hop of a redirect included, or one whose record failed;
//     a record holds anything but the host (a path, a query, a header); a refusal's record lacks its code; a request
//     from Bash (any client, any method) isn't recorded; a record can be updated.
import { fc, it as prop } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { addressVerdict } from './ip.ts'
import { env } from 'cloudflare:workers'
import { checkUrl, FETCH_HEADERS, handleWebFetch, recordFetch, REFUSAL_RECORDS_PER_MINUTE, WEBFETCH_MAX_BYTES, type FetchRecord } from './webfetch.ts'

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

async function run(url: string, opts: { list?: string | null; method?: string; headers?: Record<string, string>; pages?: Record<string, () => Response>; dns?: Dns; recordFails?: boolean; refusalRecordHangs?: boolean } = {}) {
  const { f, fetched } = net(opts.dns ?? PUBLIC_DNS, opts.pages ?? { 'https://docs.example.com/a': page(), 'https://other.example.org/b': page() })
  const logs: Record<string, unknown>[] = []
  const records: FetchRecord[] = []
  let recordFailures = 0
  const later: Promise<unknown>[] = []
  const record = async (r: FetchRecord) => {
    if (opts.recordFails) throw new Error('d1 down')
    if (opts.refusalRecordHangs && r.verdict === 'refused') await new Promise(() => {})
    records.push(r)
  }
  const res = await handleWebFetch(new Request(url, { method: opts.method ?? 'GET', headers: opts.headers }), { fetchOn: async () => true, hostList: async () => opts.list ?? null, checkLeak: async () => false, fetch: f, log: e => void logs.push(e), record, noteRecordFailure: async () => { recordFailures++ }, waitUntil: p => void later.push(p) })
  // What the runtime would finish after the answer: a refusal's record (never one that hangs).
  if (!opts.refusalRecordHangs) await Promise.all(later)
  return { res, fetched, logs, records, later, recordFailures }
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
    // Decision L1: only Inhouse's fixed accept, accept-language and user-agent go upstream, never the caller's.
    expect([...fetched[0]!.headers]).toEqual(Object.entries(FETCH_HEADERS).sort(([a], [b]) => a.localeCompare(b)))
  })
  it("pins accept, accept-language and user-agent: the agent's own values (which could carry data) never go upstream", async () => {
    const carried = { accept: 'text/alice@example.com', 'accept-language': 'x-5550000001001', 'user-agent': 'ord_AbC123def456ghi' }
    const { res, fetched } = await run('https://docs.example.com/a', { list: ALL, headers: carried })
    expect(res.status).toBe(200)
    const sent = Object.fromEntries(fetched[0]!.headers)
    expect(sent).toEqual(FETCH_HEADERS)
    for (const v of Object.values(carried)) expect(JSON.stringify(sent)).not.toContain(v)
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

describe('the egress record (P8a, failure 6)', () => {
  it('an allowed request is recorded by host before it goes out; a refused one with its code', async () => {
    const ok = await run('https://docs.example.com/a?token=SECRET#frag', { list: ALL, headers: { 'x-data': 'SECRET' } })
    expect(ok.records).toEqual([{ host: 'docs.example.com', verdict: 'allowed', code: null }])
    const no = await run('https://other.example.org/SECRET', { list: 'docs.example.com' })
    expect(no.records).toEqual([{ host: 'other.example.org', verdict: 'refused', code: 'not_listed' }])
    const empty = await run('https://docs.example.com/a')
    expect(empty.records).toEqual([{ host: 'docs.example.com', verdict: 'refused', code: 'not_listed' }])
  })
  it('each redirect hop is its own record; the refused hop records its code', async () => {
    const pages = {
      'https://docs.example.com/a': () => new Response(null, { status: 302, headers: { location: 'https://other.example.org/b?x=SECRET' } }),
      'https://docs.example.com/b': () => new Response(null, { status: 301, headers: { location: '/c' } }),
      'https://docs.example.com/c': page('moved'),
    }
    expect((await run('https://docs.example.com/b', { list: ALL, pages })).records).toEqual([
      { host: 'docs.example.com', verdict: 'allowed', code: null }, { host: 'docs.example.com', verdict: 'allowed', code: null },
    ])
    expect((await run('https://docs.example.com/a', { list: 'docs.example.com', pages })).records).toEqual([
      { host: 'docs.example.com', verdict: 'allowed', code: null }, { host: 'other.example.org', verdict: 'refused', code: 'not_listed' },
    ])
  })
  it("a request from Bash (curl's client, a POST) is recorded the same way: the egress sees every container HTTPS request", async () => {
    const post = await run('https://docs.example.com/upload', { list: ALL, method: 'POST', headers: { 'user-agent': 'curl/8.5.0' } })
    expect(post.res.status).toBe(405)
    expect(post.records).toEqual([{ host: 'docs.example.com', verdict: 'refused', code: 'method' }])
    const get = await run('https://docs.example.com/a', { list: ALL, headers: { 'user-agent': 'curl/8.5.0' } })
    expect(get.records).toEqual([{ host: 'docs.example.com', verdict: 'allowed', code: null }])
  })
  it("a refusal doesn't wait on its record (handed to waitUntil); a failed one is logged and reported to health", async () => {
    const hung = await run('https://other.example.org/b', { list: 'docs.example.com', refusalRecordHangs: true })
    expect(hung.res.status).toBe(403)
    expect(hung.later).toHaveLength(1)
    const failed = await run('https://other.example.org/b', { list: 'docs.example.com', recordFails: true })
    expect(failed.res.status).toBe(403)
    expect(failed.recordFailures).toBe(1)
    expect(failed.logs).toContainEqual(expect.objectContaining({ event: 'egress_record_failed', verdict: 'refused' }))
  })
  it('a request whose record fails never goes out', async () => {
    const r = await run('https://docs.example.com/a', { list: ALL, recordFails: true })
    expect(r.res.status).toBe(403)
    expect(await r.res.text()).toBe('WebFetch refused: record')
    expect(r.recordFailures).toBe(1)
    expect(r.fetched).toEqual([])
  })
  prop.prop([fc.webPath(), fc.webQueryParameters(), fc.stringMatching(/^[a-z0-9]{6,12}$/), fc.boolean()])(
    'no record ever holds a path, a query or a header (a canary in each never lands)', async (path, query, canary, listed) => {
      const url = `https://docs.example.com/${canary}${path}?c=${canary}&${query}`
      const r = await run(url, { list: listed ? ALL : 'other.example.org', headers: { 'x-canary': canary, cookie: canary } })
      expect(r.records.length).toBeGreaterThan(0)
      for (const rec of r.records) {
        expect(Object.keys(rec).sort()).toEqual(['code', 'host', 'verdict'])
        expect(JSON.stringify(rec)).not.toContain(canary)
      }
    },
  )
  // The host part itself: case, one trailing dot, userinfo, a port (443 or another), an IP literal, an IDN. The record
  // keeps the hostname as the checks see it (lowercase, no trailing dot): never the port, the userinfo or a slash.
  const NAME = fc.oneof(
    fc.constantFrom('docs.example.com', 'Docs.Example.COM', 'other.example.org', '93.184.216.34', '[2606:2800:220:1::1]', 'bücher.example', 'ÄBC.example.com'),
    LABEL.map(l => `${l}.example.com`),
  )
  prop.prop([NAME, fc.boolean(), fc.constantFrom('', 'user:pw@', 'u@'), fc.constantFrom('', ':443', ':8443'), fc.stringMatching(/^[a-z0-9]{6,12}$/)])(
    'a record holds the normalised hostname only, whatever the host part carries', async (name, dot, userinfo, port, canary) => {
      const url = `https://${userinfo.replace('pw', canary)}${name}${dot && !name.startsWith('[') ? '.' : ''}${port}/p`
      const r = await run(url, { list: ALL })
      expect(r.records.length).toBeGreaterThan(0)
      const rec = r.records[0]!
      expect(rec.host).toBe(new URL(url).hostname.replace(/\.$/, '').toLowerCase())
      expect(rec.host).not.toMatch(/[@/]/)
      if (!name.startsWith('[')) expect(rec.host).not.toContain(':')
      expect(rec.host).not.toContain(canary)
    },
  )
})

describe('recordFetch: the D1 row (P8a, failure 6)', () => {
  it('never reuses a row number, even after the newest row is deleted (AUTOINCREMENT: the backup reads by rising n)', async () => {
    const db = env.DB
    const src = { runner: 'runner-0', containerGen: 1 }
    await recordFetch(db, src, { host: 'a.example.com', verdict: 'allowed', code: null }, 1)
    const first = (await db.prepare('SELECT MAX(n) AS n FROM egress_fetches').first<{ n: number }>())!.n
    await db.prepare('DELETE FROM egress_fetches WHERE n = ?').bind(first).run()
    await recordFetch(db, src, { host: 'b.example.com', verdict: 'allowed', code: null }, 2)
    expect((await db.prepare('SELECT MAX(n) AS n FROM egress_fetches').first<{ n: number }>())!.n).toBeGreaterThan(first)
  })
  it('appends host, verdict, code, runner and generation, and refuses an UPDATE', async () => {
    const db = env.DB
    await db.prepare('DELETE FROM egress_fetches').run()
    await recordFetch(db, { runner: 'runner-0', containerGen: 3 }, { host: 'docs.example.com', verdict: 'allowed', code: null }, 1_800_000_000_000)
    await recordFetch(db, { runner: 'runner-0', containerGen: 3 }, { host: 'evil.example.org', verdict: 'refused', code: 'not_listed' }, 1_800_000_000_001)
    expect((await db.prepare('SELECT at_ms, host, verdict, code, runner, container_gen FROM egress_fetches ORDER BY n').all()).results).toEqual([
      { at_ms: 1_800_000_000_000, host: 'docs.example.com', verdict: 'allowed', code: null, runner: 'runner-0', container_gen: 3 },
      { at_ms: 1_800_000_000_001, host: 'evil.example.org', verdict: 'refused', code: 'not_listed', runner: 'runner-0', container_gen: 3 },
    ])
    await expect(db.prepare("UPDATE egress_fetches SET host = 'x.example.com'").run()).rejects.toThrow(/append-only/)
    await expect(db.prepare("INSERT INTO egress_fetches (at_ms, host, verdict, code, runner, container_gen) VALUES (1, 'a.example.com', 'allowed', 'method', 'r', 1)").run()).rejects.toThrow()
  })
})


it('caps refused records across runners for one minute and always records allowed requests', async () => {
  const db = env.DB
  const at = 1_900_000_000_000
  const denied = { host: 'unlisted.example.test', verdict: 'refused', code: 'not_listed' } as const
  const source = { runner: 'runner-a', containerGen: 1 }
  await Promise.all(Array.from({ length: REFUSAL_RECORDS_PER_MINUTE + 2 }, (_, i) =>
    recordFetch(db, { ...source, runner: i % 2 === 0 ? 'runner-a' : 'runner-b' }, denied, at),
  ))
  await recordFetch(db, source, { host: 'listed.example.test', verdict: 'allowed', code: null }, at)
  await recordFetch(db, source, denied, at + 59_999)
  await recordFetch(db, source, denied, at + 60_000)
  const rows = await db.prepare('SELECT verdict, at_ms, COUNT(*) AS n FROM egress_fetches WHERE at_ms >= ? GROUP BY verdict, at_ms ORDER BY at_ms, verdict')
    .bind(at).all()
  expect(rows.results).toEqual([
    { verdict: 'allowed', at_ms: at, n: 1 },
    { verdict: 'refused', at_ms: at, n: REFUSAL_RECORDS_PER_MINUTE },
    { verdict: 'refused', at_ms: at + 60_000, n: 1 },
  ])
})
