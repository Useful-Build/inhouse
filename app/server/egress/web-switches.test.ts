// M1-F (N7): the brand's web switches, an Admin's to flip, against the real migrations and a fake network that counts
// every call (DNS over HTTPS and page requests alike). Ways it can fail, written down first:
//  1. with reading web pages off, the egress still makes a DNS lookup or a page request, or runs the leak check first;
//  2. a session that was already running (or a redirect already under way) keeps reading pages after an Admin turns it
//     off: the switch is read once, not before every hop;
//  3. a failed read of the switch lets the request through (it must refuse);
//  4. with both switches off, a chat turn or a routine turn still resolves `webSearch: true` or a fetch host; with them
//     on, the Inhouse team's host list and the search switch no longer reach the turn;
//  5. the model route lets a web search tool reach the model with the switch off, read from the real settings rows;
//  6. a Member can flip a switch, an Admin can't, or an Admin can widen which hosts are read (`t:webfetch`);
//  7. a value stored before the switch became a brand setting is lost, or reads differently, after the move.
import { fc, test } from '@fast-check/vitest'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { accessMatrix } from '../access-matrix.ts'
import { resolveTurnSettings } from '../api/runs.ts'
import { putBrandSetting, putTechnicalSetting } from '../api/settings.ts'
import { openStores } from '../db/stores.ts'
import { ctx, person, personPrincipal, reset } from '../db/test-support.ts'
import { submitSettings } from '../routines/brand.ts'
import { settingSpec } from '../../shared/contract/settings.ts'
import { webFetchOn, webSearchOn } from '../../shared/contract/settings-table.ts'
import { brandSettings, handleEgress } from './index.ts'
import { egressRequest, harness, NO_CAPTURE } from './testing/harness.ts'
import { handleWebFetch, storedFetchOn, webEgressDeps, type FetchRecord, type WebDeps } from './webfetch.ts'

const db = env.DB
const stores = openStores(env)
let admin: string
let u = 0

beforeEach(async () => {
  await reset(db)
  const k = `${++u}-${Math.random().toString(36).slice(2, 7)}`
  admin = await person(stores, { email: `adm-${k}@example.test`, subject: `sadm-${k}`, role: 'admin' })
})

/** An Admin's write through route 10 (the brand scope), at the rev stored now. */
async function adminSets(key: string, value: unknown): Promise<Response> {
  const rev = (await db.prepare("SELECT rev FROM settings WHERE owner = 'brand' AND key = ?").bind(key).first<number>('rev')) ?? 0
  const { c } = ctx(stores, personPrincipal(admin, 'admin'), { method: 'PUT', path: `/api/settings/brand/${key}`, params: { key }, body: { value, ifRev: rev } })
  return putBrandSetting(c)
}
/** The Inhouse team's host list, written as a stored row (its own route and gate are tested in api/settings.test.ts). */
const listHosts = (hosts: string) =>
  db.prepare("INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES ('brand', 't:webfetch', ?, 1, 1, 'inhouse', 'r')").bind(JSON.stringify(hosts)).run()

/** A network that answers every name as public and every page with 200, and counts each call it gets. */
function countingNet(onPage: (url: string) => Promise<Response> | Response = () => new Response('page')) {
  const calls: string[] = []
  const f = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    if (url.startsWith('https://cloudflare-dns.com/')) {
      const type = new URL(url).searchParams.get('type')
      return Response.json({ Status: 0, Answer: type === 'A' ? [{ type: 1, data: '93.184.216.34' }] : [] })
    }
    return onPage(url)
  }) as typeof fetch
  return { f, calls }
}

/**
 * The egress's production deps (`webEgressDeps`, what WebEgress runs) over a counting network: only `fetch` is replaced.
 * The leak check and the record still run as in production; they're watched on the way through.
 */
function webDeps(f: typeof fetch, over: Partial<WebDeps> = {}) {
  const leakChecks: string[] = []
  const records: FetchRecord[] = []
  const later: Promise<unknown>[] = []
  const prod = webEgressDeps(env, { waitUntil: p => { later.push(p) } }, { runner: 'runner-web-switches', containerGen: 1 })
  const d: WebDeps = {
    ...prod,
    fetch: f,
    checkLeak: url => { leakChecks.push(url.href); return prod.checkLeak(url) },
    record: r => { records.push(r); return prod.record(r) },
    ...over,
  }
  return { d, leakChecks, records, settle: () => Promise.all(later) }
}

describe('the off switch at the network seam (failures 1 to 3)', () => {
  it('off: refused before the leak check, DNS or any page request; zero network calls', async () => {
    await listHosts('docs.example.com')
    expect((await adminSets('t:webfetch_on', false)).status).toBe(200)
    const net = countingNet()
    const w = webDeps(net.f)
    const res = await handleWebFetch(new Request('https://docs.example.com/a'), w.d)
    await w.settle()
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('WebFetch refused: off')
    expect(net.calls).toEqual([])
    expect(w.leakChecks).toEqual([])
    expect(w.records).toEqual([{ host: 'docs.example.com', verdict: 'refused', code: 'off' }])
  })

  it('a session already running: pages go out while on, and none after an Admin turns it off', async () => {
    await listHosts('docs.example.com')
    const net = countingNet()
    const w = webDeps(net.f)
    // On by default (no row): the running session reads a page.
    expect((await handleWebFetch(new Request('https://docs.example.com/a'), w.d)).status).toBe(200)
    expect(net.calls.filter(c => c.startsWith('https://docs.example.com/'))).toEqual(['https://docs.example.com/a'])
    const before = net.calls.length
    expect((await adminSets('t:webfetch_on', false)).status).toBe(200)
    for (const path of ['/a', '/b']) expect((await handleWebFetch(new Request(`https://docs.example.com${path}`), w.d)).status).toBe(403)
    expect(net.calls.length).toBe(before)
    // And back on: the same session reads again.
    expect((await adminSets('t:webfetch_on', true)).status).toBe(200)
    expect((await handleWebFetch(new Request('https://docs.example.com/c'), w.d)).status).toBe(200)
    expect(net.calls.at(-1)).toBe('https://docs.example.com/c')
  })

  it('a redirect under way: the next hop is refused once an Admin turns it off, with no further call', async () => {
    await listHosts('docs.example.com')
    const net = countingNet(async url => {
      if (url === 'https://docs.example.com/start') {
        // The switch goes off while the first page answers.
        expect((await adminSets('t:webfetch_on', false)).status).toBe(200)
        return new Response(null, { status: 302, headers: { location: '/next' } })
      }
      return new Response('page')
    })
    const w = webDeps(net.f)
    const res = await handleWebFetch(new Request('https://docs.example.com/start'), w.d)
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('WebFetch refused: off')
    expect(net.calls.filter(c => c.startsWith('https://docs.example.com/'))).toEqual(['https://docs.example.com/start'])
    expect(net.calls.at(-1)).toBe('https://docs.example.com/start')
  })

  it("a switch that can't be read refuses, with zero network calls", async () => {
    await listHosts('docs.example.com')
    const net = countingNet()
    const w = webDeps(net.f, { fetchOn: async () => { throw new Error('d1 unreachable') } })
    const res = await handleWebFetch(new Request('https://docs.example.com/a'), w.d)
    expect(await res.text()).toBe('WebFetch refused: off')
    expect(net.calls).toEqual([])
  })

  test.prop([fc.oneof(fc.boolean(), fc.constant(null), fc.string({ maxLength: 8 }), fc.integer())])(
    'only a stored false, or a value that is neither a switch nor a reset, reads as off; a missing row is on', async v => {
      await db.prepare("DELETE FROM settings WHERE owner = 'brand' AND key = 't:webfetch_on'").run()
      expect(await storedFetchOn(db)).toBe(true)
      await db.prepare("INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES ('brand', 't:webfetch_on', ?, 1, 1, 'x', 'r')").bind(JSON.stringify(v)).run()
      expect(await storedFetchOn(db)).toBe(v === true || v === null)
      expect(webFetchOn(v)).toBe(v === true || v === null)
      expect(webSearchOn(v)).toBe(v === true)
    },
  )
})

describe('what a turn is resolved with (failure 4)', () => {
  it('both off: a chat turn and a routine turn have webSearch false and no fetch host, whatever the host list says', async () => {
    await listHosts('docs.example.com\nexample.com')
    expect((await adminSets('t:websearch', false)).status).toBe(200)
    expect((await adminSets('t:webfetch_on', false)).status).toBe(200)
    expect(await resolveTurnSettings(stores.settings, 'sonnet')).toMatchObject({ webSearch: false, webFetchDomains: [] })
    expect(await submitSettings(db)).toMatchObject({ webSearch: false, webFetchDomains: [] })
  })
  it('both on: the search switch and the Inhouse team\'s list reach both kinds of turn', async () => {
    await listHosts('docs.example.com\nexample.com')
    expect((await adminSets('t:websearch', true)).status).toBe(200)
    expect((await adminSets('t:webfetch_on', true)).status).toBe(200)
    const want = { webSearch: true, webFetchDomains: ['docs.example.com', 'example.com'] }
    expect(await resolveTurnSettings(stores.settings, 'sonnet')).toMatchObject(want)
    expect(await submitSettings(db)).toMatchObject(want)
  })
  it('a routine turn reads a web switch row that does not parse as off (fail closed)', async () => {
    await listHosts('example.com')
    for (const key of ['t:webfetch_on', 't:websearch']) {
      await db.prepare("INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES ('brand', ?, 'not json', 1, 1, 'x', 'r')").bind(key).run()
    }
    expect(await submitSettings(db)).toMatchObject({ webSearch: false, webFetchDomains: [] })
    // The egress refuses on the same row: its read throws, and a failed read refuses.
    const net = countingNet()
    expect(await (await handleWebFetch(new Request('https://example.com/'), webDeps(net.f).d)).text()).toBe('WebFetch refused: off')
    expect(net.calls).toEqual([])
  })
  it('the defaults: search off, reading on (so the list decides)', async () => {
    await listHosts('example.com')
    expect(await resolveTurnSettings(stores.settings, 'sonnet')).toMatchObject({ webSearch: false, webFetchDomains: ['example.com'] })
    expect(await submitSettings(db)).toMatchObject({ webSearch: false, webFetchDomains: ['example.com'] })
  })
})

describe('the model route reads the brand switch (failure 5)', () => {
  const searching = { model: 'claude-sonnet-5-5', max_tokens: 1000, messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'web_search_20250305', name: 'web_search' }] }
  it('off: a request with a web search tool never reaches the model; on: it does', async () => {
    expect((await adminSets('t:websearch', false)).status).toBe(200)
    const off = await harness({ settings: () => brandSettings(db) })
    const res = await handleEgress(egressRequest('/model/v1/messages', { body: searching }), off.deps, NO_CAPTURE)
    expect(res.status).toBe(400)
    expect(off.upstreamCalls).toEqual([])
    expect(off.rpc.callsOf('admitModelCall')).toEqual([])
    expect((await adminSets('t:websearch', true)).status).toBe(200)
    const on = await harness({ settings: () => brandSettings(db) })
    expect((await handleEgress(egressRequest('/model/v1/messages', { body: searching }), on.deps, NO_CAPTURE)).status).toBe(200)
    expect(on.upstreamCalls.map(c => c.path)).toEqual(['/v1/messages'])
    expect((JSON.parse(on.upstreamCalls[0]!.body) as { tools: { name: string }[] }).tools.map(t => t.name)).toEqual(['web_search'])
  })
})

describe('who may flip them, and who may widen what is read (failure 6)', () => {
  it('both are brand settings: route 10 only, which admits Admins and the Inhouse team and never a Member', () => {
    for (const key of ['t:websearch', 't:webfetch_on']) expect(settingSpec(key)!.scope, key).toBe('brand')
    const row = accessMatrix.find(r => r.method === 'PUT' && r.pattern === '/api/settings/brand/:key')!
    expect([...row.allow].sort()).toEqual(['admin', 'inhouse'])
  })
  it('the host list stays technical: an Admin can switch reading off and on but never list a host', async () => {
    expect(settingSpec('t:webfetch')!.scope).toBe('technical')
    // Through route 10 it's the wrong scope; on route 12 the Admin's object rule refuses it (api/settings.test.ts).
    const { c } = ctx(stores, personPrincipal(admin, 'admin'), { method: 'PUT', path: '/api/settings/brand/t:webfetch', params: { key: 't:webfetch' }, body: { value: 'evil.example.com', ifRev: 0 } })
    expect((await putBrandSetting(c)).status).toBe(404)
    for (const key of ['t:websearch', 't:webfetch_on']) {
      const t = ctx(stores, personPrincipal(admin, 'admin'), { method: 'PUT', path: `/api/settings/technical/${key}`, params: { key }, body: { value: true, ifRev: 0 } })
      expect((await putTechnicalSetting(t.c)).status, key).toBe(404)
    }
    expect(await db.prepare("SELECT key FROM settings WHERE owner = 'brand'").all()).toMatchObject({ results: [] })
  })
})

describe('a value stored before the move (failure 7)', () => {
  it('a t:websearch row written while it was technical keeps its value and rev, lists under brand and drives the turn', async () => {
    // As the Inhouse team's technical write stored it before M1-F: same owner and key, no scope in the row.
    await db.prepare("INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES ('brand', 't:websearch', 'true', 3, 1, 'inhouse', 'r')").run()
    const brand = await stores.settings.list('brand', 'brand')
    expect(brand.find(r => r.key === 't:websearch')).toMatchObject({ value: true, rev: 3 })
    expect((await stores.settings.list('brand', 'technical')).some(r => r.key === 't:websearch')).toBe(false)
    expect(await resolveTurnSettings(stores.settings, 'sonnet')).toMatchObject({ webSearch: true })
    expect(await brandSettings(db)).toMatchObject({ 't:websearch': true })
    // An Admin writes it at that rev.
    expect((await adminSets('t:websearch', false)).status).toBe(200)
    expect((await stores.settings.list('brand', 'brand')).find(r => r.key === 't:websearch')).toMatchObject({ value: false, rev: 4 })
  })
})
