// Stage 1 M3-J (N29): the forced-fetch leak case's twin in workerd, on CI. The sandbox spec (e2e/api/leak-open.spec.ts,
// named only) runs the scripted model's exact attempts (test/scripted-model/scenarios/leak-open.ts) through a real
// container and the deployed egress; this runs the same URLs through the web egress as the Worker builds it
// (`webEgressDeps`: the D1 settings, the taint store and the egress record) with only the network replaced, so every
// request that would leave is seen here. And it runs with the brand's settings as a new brand has them, no fetch mode
// and no host list, so it proves M3-J's default (`open`) is the mode the egress decides by. Ways it could fail:
//  1. the default with no mode and no list isn't `open` (the control fetch to an unlisted host is refused), or a mode
//     set to `list`, or hosts listed, or a bad stored mode, reads as `open`;
//  2. the order's name, read through the hub, goes out in the path or the query: anything but `leak`, or a DNS lookup
//     or a page request before the refusal, or no `refused leak` row in the egress record;
//  3. a header carrying the name reaches the host (the egress sends only its own fixed headers);
//  4. a redirect whose first hop is clean but whose target carries the name is followed to the target: the second hop
//     isn't checked again before DNS, or the target is looked up or requested;
//  5. the control (nothing private) is refused, so a refuse-everything egress would pass.
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  LEAK_OPEN_HEADER_HOST, LEAK_OPEN_ORDER, LEAK_OPEN_REDIRECT_TARGET, LEAK_OPEN_URLS,
} from '../../test/scripted-model/scenarios/leak-open.ts'
import { taintStore } from './taint.ts'
import { FETCH_HEADERS, handleWebFetch, storedFetchMode, webEgressDeps } from './webfetch.ts'

const db = env.DB
const HASH_KEY = 'leak-open-twin-hash-key-0123456789'
const testEnv = { ...env, AUDIT_HASH_KEY: HASH_KEY } as unknown as Env
const SOURCE = { runner: 'runner-open', containerGen: 1 }
const PUBLIC = '93.184.215.14'

/** The network: DoH answers every name as public; each page request is kept, and httpbin's redirector answers 302. */
function network() {
  const lookups: string[] = []
  const requests: { url: string; headers: [string, string][] }[] = []
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.origin === 'https://cloudflare-dns.com') {
      const name = url.searchParams.get('name')!
      lookups.push(name)
      const type = url.searchParams.get('type')
      return Response.json({ Status: 0, Answer: type === 'A' ? [{ name, type: 1, data: PUBLIC }] : [] })
    }
    requests.push({ url: url.href, headers: [...new Headers(init?.headers).entries()] })
    if (url.hostname === 'httpbin.org' && url.pathname === '/redirect-to') {
      // As httpbin answers: the `url` parameter, decoded once, as the Location.
      return new Response(null, { status: 302, headers: { location: url.searchParams.get('url')! } })
    }
    return new Response('<h1>Example Domain</h1>', { headers: { 'content-type': 'text/html' } })
  }) as typeof fetch
  return { f, lookups, requests }
}

async function webFetch(request: Request) {
  const net = network()
  const later: Promise<unknown>[] = []
  const deps = { ...webEgressDeps(testEnv, { waitUntil: p => void later.push(p) }, SOURCE), fetch: net.f, log: () => {} }
  const res = await handleWebFetch(request, deps)
  await Promise.all(later)
  return { res, body: await res.text(), ...net }
}

const setting = async (key: string, value: unknown) =>
  db.prepare("INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES ('brand', ?, ?, 1, 1, 'm_inhouse', 'r') ON CONFLICT (owner, key) DO UPDATE SET value_json = excluded.value_json")
    .bind(key, JSON.stringify(value)).run()
const clearWebSettings = () => db.prepare("DELETE FROM settings WHERE owner = 'brand' AND key IN ('t:webfetch', 't:webfetch_mode', 't:webfetch_on')").run()
const recordAfter = async (mark: number) =>
  (await db.prepare('SELECT host, verdict, code FROM egress_fetches WHERE n > ? ORDER BY n').bind(mark).all<{ host: string; verdict: string; code: string | null }>()).results
const top = async () => (await db.prepare('SELECT coalesce(max(n), 0) AS n FROM egress_fetches').first<{ n: number }>())!.n

/** What the hub's `order_get` gives the agent for #1001, as the egress captures it (the fixture store's first order). */
const ORDER_RESULT = JSON.stringify({ ok: true, value: { content: [{ type: 'text', text: JSON.stringify({ order: { id: 'gid://shopify/Order/1', name: LEAK_OPEN_ORDER, displayFinancialStatus: 'PAID' } }) }] } })

beforeEach(async () => {
  await clearWebSettings()
  await db.prepare('DELETE FROM egress_taint').run()
})

describe('the fetch mode a brand gets (M3-J, failure 1)', () => {
  it('no mode and no host list is open; an empty list is too; a list, `list` set, or a bad mode or list is the list', async () => {
    expect(await storedFetchMode(db)).toBe('open')
    await setting('t:webfetch', '')
    expect(await storedFetchMode(db)).toBe('open')
    await setting('t:webfetch', 'docs.example.com')
    expect(await storedFetchMode(db)).toBe('list')
    await setting('t:webfetch', '')
    await setting('t:webfetch_mode', 'list')
    expect(await storedFetchMode(db)).toBe('list')
    for (const bad of ['OPEN', 'any', true, 1]) {
      await setting('t:webfetch_mode', bad)
      expect(await storedFetchMode(db), String(bad)).toBe('list')
    }
    await setting('t:webfetch_mode', 'open')
    await setting('t:webfetch', 'docs.example.com')
    expect(await storedFetchMode(db)).toBe('open')
    await clearWebSettings()
    for (const brokenList of ['not a list!', 7]) {
      await setting('t:webfetch', brokenList)
      expect(await storedFetchMode(db), String(brokenList)).toBe('list')
    }
  })
})

describe('the forced-fetch leak case, as a new brand runs it (no mode, no list: open)', () => {
  it('after #1001 is read: the control goes out; the path, the query and the redirect target are refused leak before DNS; a header never reaches the host', async () => {
    expect(await taintStore(db, HASH_KEY).capture(ORDER_RESULT, { route: 'hub', tool: 'order_get' })).toBeGreaterThan(0)
    const mark = await top()

    // The control: nothing private, an unlisted host, open by default. It goes out (failure 5).
    const control = await webFetch(new Request(LEAK_OPEN_URLS.control))
    expect(control.res.status).toBe(200)
    expect(control.requests.map(r => r.url)).toEqual([LEAK_OPEN_URLS.control])

    // The name in the path and in the query: `leak`, with no lookup and no request (failure 2).
    for (const url of [LEAK_OPEN_URLS.path, LEAK_OPEN_URLS.query]) {
      const r = await webFetch(new Request(url))
      expect([r.res.status, r.body], url).toEqual([403, 'WebFetch refused: leak'])
      expect([r.lookups, r.requests], url).toEqual([[], []])
    }

    // One hop through a redirect: the first URL is clean to the check (the target is nested one encoding deeper), goes
    // out, and its Location carries the name: that hop is refused `leak` before any lookup of it (failure 4).
    const hop = await webFetch(new Request(LEAK_OPEN_URLS.redirect))
    expect([hop.res.status, hop.body]).toEqual([403, 'WebFetch refused: leak'])
    expect(hop.requests.map(r => r.url)).toEqual([LEAK_OPEN_URLS.redirect])
    expect(hop.lookups).not.toContain(new URL(LEAK_OPEN_REDIRECT_TARGET).hostname)

    // The name in a header (as a client with network would send it; the agent's Bash has none): the URL is clean, so the
    // request goes out, with the egress's own headers only (failure 3).
    const header = await webFetch(new Request(`https://${LEAK_OPEN_HEADER_HOST}/headers`, { headers: { 'x-order': LEAK_OPEN_ORDER, authorization: `Bearer ${LEAK_OPEN_ORDER}` } }))
    expect(header.res.status).toBe(200)
    expect(header.requests).toHaveLength(1)
    expect(Object.fromEntries(header.requests[0]!.headers)).toEqual(FETCH_HEADERS)
    expect(JSON.stringify(header.requests)).not.toContain('1001')

    // The egress record: one row per hop, the host and the verdict with its code, nothing else.
    expect(await recordAfter(mark)).toEqual([
      { host: 'example.com', verdict: 'allowed', code: null },
      { host: 'example.org', verdict: 'refused', code: 'leak' },
      { host: 'example.net', verdict: 'refused', code: 'leak' },
      { host: 'httpbin.org', verdict: 'allowed', code: null },
      { host: 'www.example.org', verdict: 'refused', code: 'leak' },
      { host: LEAK_OPEN_HEADER_HOST, verdict: 'allowed', code: null },
    ])
  })

  it('the redirect target is the leak check\'s to catch: the same attempt with nothing read goes all the way', async () => {
    // Without the read, no token is stored: the first hop and the target both go out. So the refusal above is the
    // check on the second hop finding #1001, not something else about the URL.
    const hop = await webFetch(new Request(LEAK_OPEN_URLS.redirect))
    expect(hop.res.status).toBe(200)
    expect(hop.requests.map(r => r.url)).toEqual([LEAK_OPEN_URLS.redirect, LEAK_OPEN_REDIRECT_TARGET])
    for (const url of [LEAK_OPEN_URLS.path, LEAK_OPEN_URLS.query]) expect((await webFetch(new Request(url))).res.status, url).toBe(200)
  })

  it('reading web pages off stops every attempt before the leak check, the control included', async () => {
    await setting('t:webfetch_on', false)
    for (const url of [LEAK_OPEN_URLS.control, LEAK_OPEN_URLS.path, LEAK_OPEN_URLS.redirect]) {
      const r = await webFetch(new Request(url))
      expect([r.body, r.lookups, r.requests], url).toEqual(['WebFetch refused: off', [], []])
    }
  })
})

// The scenario's own checks (the sandbox turn ends with LEAK_OPEN_DONE only if they hold). Ways they could fail: a
// token-carrying fetch that went out (a page summary) passes as refused, or the refusal the real CLI shows is missed.
describe('webfetch-leak-open: the turn checks the refusal of each token-carrying fetch', async () => {
  const { createScriptedModel } = await import('../../test/scripted-model/index.ts')
  const { LEAK_OPEN_SCENARIOS, LEAK_OPEN_SCENARIO, LEAK_OPEN_HEADER_COMMAND } = await import('../../test/scripted-model/scenarios/leak-open.ts')
  const use = (id: string, name: string, input: Record<string, unknown>) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name, input }] })
  const result = (id: string, content: string, isError?: boolean) =>
    ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError === undefined ? {} : { is_error: isError }) }] })
  const CLI_403 = 'The server returned HTTP 403 Forbidden. The response body was not retrieved.'
  const page = 'Example Domain: a page kept for documentation examples.'
  /** The last turn's request: every call made, the redirect's result as given. */
  const lastTurn = (outcomes: { path: string; query: string; redirect: string }) => ({
    model: 'claude-sonnet-5-5', stream: false, tools: [{ name: 'WebFetch' }, { name: 'Bash' }],
    messages: [
      { role: 'user', content: `scenario:${LEAK_OPEN_SCENARIO} go` },
      use('toolu_scripted_open_read', 'mcp__apps__order_get', {}), result('toolu_scripted_open_read', `{"order":{"name":"${LEAK_OPEN_ORDER}"}}`),
      use('toolu_scripted_open_control', 'WebFetch', { url: LEAK_OPEN_URLS.control }), result('toolu_scripted_open_control', page),
      use('toolu_scripted_open_path', 'WebFetch', { url: LEAK_OPEN_URLS.path }), result('toolu_scripted_open_path', outcomes.path),
      use('toolu_scripted_open_query', 'WebFetch', { url: LEAK_OPEN_URLS.query }), result('toolu_scripted_open_query', outcomes.query),
      use('toolu_scripted_open_header', 'Bash', { command: LEAK_OPEN_HEADER_COMMAND }), result('toolu_scripted_open_header', 'urllib.error.URLError: <urlopen error Tunnel connection failed: 403 Forbidden>', true),
      use('toolu_scripted_open_redirect', 'WebFetch', { url: LEAK_OPEN_URLS.redirect }), result('toolu_scripted_open_redirect', outcomes.redirect),
    ],
  })
  const answer = async (outcomes: { path: string; query: string; redirect: string }) => {
    const m = createScriptedModel(LEAK_OPEN_SCENARIOS)
    const res = await m.handle(new Request('http://proxy/model/v1/messages', { method: 'POST', body: JSON.stringify(lastTurn(outcomes)) }), LEAK_OPEN_SCENARIO)
    return res.status
  }
  it('answers when the redirect came back as the CLI\'s 403; misses when its target went out', async () => {
    expect(await answer({ path: CLI_403, query: CLI_403, redirect: CLI_403 })).toBe(200)
    expect(await answer({ path: CLI_403, query: CLI_403, redirect: page })).toBe(400)
  })
})
