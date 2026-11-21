// Code mode on workerd (P5 W2, A.7.3 to A.7.12; CI, the test config): real Dynamic Workers through env.LOADER, the
// real Shopify SignIn on SQLite and the recorded fixture upstream through H0's seam. Needs the orchestrator's lines:
// `worker_loaders` (LOADER) in wrangler.hub.test.jsonc, `codeModeConnector` in connectors/index.ts (test 10) and the
// index.ts wiring (ReadGateway passes codemode). Tests 3 to 9, 11 and 12 build code mode themselves over env.LOADER.
//
// Failure modes: the RpcTarget never reaches the sandbox (3); a script reaches the network (4) or writes, reads a
// protected field or filters on one (5); a cap doesn't hold (6); the hub trusts what the sandbox returns (7); a late
// call or a kept `shop` reaches Shopify (8); the loader asks for the same code twice (9); pause or readiness doesn't
// cover the tool (10); the token leaks anywhere (11); the S4 answers drift (12).
import { env, reset } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CallerScope, ConnectGateway, HubResult, ReadGateway, ToolInfo } from '../index/contract'
import { testUpstreams } from '../testing/index'
import { readyGatewayDeps } from '../signin/signin'
import type { ToolContext } from '../registry/registry'
import { SHOPIFY_API_VERSION, RECORD_PRODUCTS } from '../connectors/shopify/documents'
import { createShopifyUpstream } from '../../test/upstreams/shopify/server'
import { dataset } from '../../test/upstreams/shopify/recordings/fixture/dataset'
import type { Dataset } from '../../test/upstreams/shopify/dataset'
import { ScriptApi } from './api'
import { createCodeMode, type CodeModeDeps } from './run'
import { codeModeConnector, shopifyScriptRun } from './route'
import { BAD_RETURN } from './script'
import { RUN_CAP, RUN_CAP_MESSAGE } from './caps'
import { ASKED_AT, MAX_ANSWER_BYTES, MEASURE_CASES } from './measure/scripts'
import { lowestStock, openReturnsNotRestocked, refundsByProductAndReason, unfulfilledOverThreeDays } from './measure/oracle'

const HOST = 'example-fixture.myshopify.com'
const run: CallerScope = { kind: 'run', runId: 'run-cm-1', principalId: 'p-1', requestId: 'req-1' }
const server: CallerScope = { kind: 'server', job: 'test', requestId: 'req-s' }
const gateways = exports as unknown as { ReadGateway: ReadGateway; ConnectGateway: ConnectGateway }
const LOADER = (env as unknown as { LOADER: WorkerLoader }).LOADER
const signIn = () => env.SIGNIN.get(env.SIGNIN.idFromName(codeModeConnector.accountId))
const PRODUCTS_PAGE = JSON.stringify(RECORD_PRODUCTS)
const d = dataset as Dataset

/** The recorded upstream, counting GraphQL requests and the most in flight at once. */
const seen = { graphql: 0, inFlight: 0, maxInFlight: 0 }
function install(token?: string) {
  const base = createShopifyUpstream(dataset)
  testUpstreams.set(HOST, async req => {
    const graphql = new URL(req.url).pathname.endsWith('/graphql.json')
    if (!graphql) {
      const res = await base(req)
      if (!token) return res
      // The canary token: the fake's own token stays behind the seam, the SignIn holds only the canary.
      const body = (await res.json()) as { access_token: string }
      realToken = body.access_token
      return new Response(JSON.stringify({ ...body, access_token: token }), { status: res.status, headers: { 'Content-Type': 'application/json' } })
    }
    seen.graphql++
    seen.inFlight++
    seen.maxInFlight = Math.max(seen.maxInFlight, seen.inFlight)
    try {
      if (!token) return await base(req)
      const headers = new Headers(req.headers)
      if (headers.get('X-Shopify-Access-Token') === token) headers.set('X-Shopify-Access-Token', realToken)
      return await base(new Request(req.url, { method: 'POST', headers, body: await req.text() }))
    } finally {
      seen.inFlight--
    }
  })
}
let realToken = ''

let lines: string[] = []
beforeEach(async () => {
  await reset()
  seen.graphql = 0
  seen.inFlight = 0
  seen.maxInFlight = 0
  install()
  lines = []
  const original = console.log
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    lines.push(a.map(String).join(' '))
    original(...a)
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  testUpstreams.set(HOST, createShopifyUpstream(dataset))
})

function codeMode(extra: Partial<CodeModeDeps> = {}) {
  return createCodeMode({
    loader: LOADER,
    bumpCounter: async (k, l, t) => (await signIn().bumpCounter(k, l, t)) as HubResult<{ ok: boolean; count: number }>,
    ...extra,
  })
}

async function ctxFor(extra: Partial<CodeModeDeps> = {}, scope: CallerScope = run): Promise<ToolContext> {
  const deps = await readyGatewayDeps(env)
  return { shopify: deps.shopifyFor(codeModeConnector), scope, nowMs: Date.now(), codemode: codeMode(extra) }
}

/** Through the tool: `{ result }` or `{ error }`. */
async function script(code: string, extra: Partial<CodeModeDeps> = {}, scope: CallerScope = run) {
  const r = await shopifyScriptRun.run(await ctxFor(extra, scope), { code })
  if (!r.ok) throw new Error(`tool error ${r.error.code}: ${r.error.message}`)
  return r.value as { result?: unknown; error?: string; calls: number; ms: number }
}

/** Straight through code mode, with the test's own ScriptApi (for the refused hook). */
async function direct(code: string, extra: Partial<CodeModeDeps> = {}, hooks: ConstructorParameters<typeof ScriptApi>[2] = {}) {
  const deps = await readyGatewayDeps(env)
  const api = new ScriptApi(deps.shopifyFor(codeModeConnector), SHOPIFY_API_VERSION, hooks)
  return { out: await codeMode(extra).run(code, api), api }
}

const catching = (call: string) => `try { await ${call}; return 'reached' } catch (e) { return String(e && e.message) }`

describe('A.7.3 the binding reaches the sandbox', () => {
  it('a script calling shop.graphql gets the recorded data back through the RpcTarget', async () => {
    const r = await script(`const r = await shop.graphql(${PRODUCTS_PAGE}, { first: 2 }); return r.data.products.nodes.map(p => p.title)`)
    expect(r.error).toBeUndefined()
    const byId = [...d.products].sort((a, b) => Number(a.id.split('/').pop()) - Number(b.id.split('/').pop()))
    expect(r.result).toEqual(byId.slice(0, 2).map(p => p.title))
    expect(r.calls).toBe(1)
    expect(seen.graphql).toBe(1)
  })
})

describe('A.7.4 no network', () => {
  for (const [label, code] of [
    ['fetch to an absolute URL', `await fetch('https://example.com'); return 'reached'`],
    ['fetch to a relative URL', `await fetch('/admin/api/2026-10/graphql.json'); return 'reached'`],
    ['connect()', `const { connect } = await import('cloudflare:sockets'); const s = connect('example.com:443'); await s.opened; return 'reached'`],
  ] as const) {
    it(`${label} fails inside the sandbox and reaches no upstream`, async () => {
      const r = await script(code)
      expect(r.result).toBeUndefined()
      expect(r.error).toEqual(expect.any(String))
      expect(seen.graphql).toBe(0)
    })
  }
})

describe('A.7.5 read-only and level 1 at runtime', () => {
  const writes = [
    'mutation { orderCancel(orderId: "gid://shopify/Order/1") { userErrors { message } } }',
    'subscription { orders { id } }',
    'mutation M { a: orderCancel(orderId: "1") { userErrors { message } } }',
    'query Q { shop { currencyCode } } mutation M { orderCancel(orderId: "1") { userErrors { message } } }',
    'fragment F on Shop { currencyCode } mutation { orderCancel(orderId: "1") { userErrors { message } } }',
  ]
  for (const doc of writes) {
    it(`write_refused: ${doc.slice(0, 50)}`, async () => {
      const r = await script(catching(`shop.graphql(${JSON.stringify(doc)})`))
      expect(r.result).toMatch(/^write_refused: /)
      expect(seen.graphql).toBe(0)
    })
  }
  const fields = [
    '{ orders(first: 1) { nodes { email } } }',
    '{ orders(first: 1) { nodes { total: email } } }',
    '{ orders(first: 1) { nodes { note } } }',
    '{ orders(first: 1) { nodes { ...F } } } fragment F on Order { customer { id } }',
    '{ orders(first: 1, query: "email:a*") { nodes { id } } }',
    '{ orders(first: 1, sortKey: CUSTOMER_NAME) { nodes { id } } }',
  ]
  for (const doc of fields) {
    it(`field not allowed: ${doc.slice(0, 60)}`, async () => {
      const r = await script(catching(`shop.graphql(${JSON.stringify(doc)})`))
      expect(r.result).toBe('invalid_args: invalid arguments: field not allowed')
      expect(seen.graphql).toBe(0)
    })
  }
  it('field not allowed through a variable', async () => {
    const doc = 'query Q($q: String) { orders(first: 1, query: $q) { nodes { id } } }'
    const r = await script(catching(`shop.graphql(${JSON.stringify(doc)}, { q: 'email:a*' })`))
    expect(r.result).toBe('invalid_args: invalid arguments: field not allowed')
    expect(seen.graphql).toBe(0)
  })
})

describe('A.7.6 caps', () => {
  it('the 11th call throws; the upstream sees 10', async () => {
    const r = await script(`for (let i = 0; i < 10; i++) await shop.graphql(${PRODUCTS_PAGE}, { first: 1 })\n${catching(`shop.graphql(${PRODUCTS_PAGE}, { first: 1 })`)}`)
    expect(r.result).toMatch(/at most 10 shop.graphql calls/)
    expect(seen.graphql).toBe(10)
  })

  it('Promise.all over 10 calls: the upstream never sees two in flight', async () => {
    const r = await script(`const all = await Promise.all(Array.from({ length: 10 }, () => shop.graphql(${PRODUCTS_PAGE}, { first: 1 }))); return all.length`)
    expect(r.result).toBe(10)
    expect(seen.graphql).toBe(10)
    expect(seen.maxInFlight).toBe(1)
  })

  it('an infinite loop is stopped by the CPU limit and comes back as the error', async () => {
    const r = await script('for (;;) {}')
    expect(r.result).toBeUndefined()
    expect(r.error).toEqual(expect.any(String))
  })

  it('a never-settling promise ends at the deadline (injected timer)', async () => {
    let fire: () => void = () => {}
    const fired = new Promise<void>(resolve => {
      fire = resolve
    })
    // The deadline fires once the script has made its one call.
    const base = createShopifyUpstream(dataset)
    testUpstreams.set(HOST, async req => {
      const res = await base(req)
      if (new URL(req.url).pathname.endsWith('/graphql.json')) fire()
      return res
    })
    const r = await script(`await shop.graphql(${PRODUCTS_PAGE}, { first: 1 }); await new Promise(() => {})`, {
      setTimer: (ms, fn) => {
        expect(ms).toBe(20_000)
        void fired.then(fn)
        return () => {}
      },
    })
    expect(r.error).toMatch(/ran past 20 s/)
  })

  it('a return over 8 KiB and non-JSON returns are refused', async () => {
    expect((await script(`return 'x'.repeat(9000)`)).error).toBe(`Error: ${BAD_RETURN}`)
    expect((await script('return 10n')).error).toMatch(/BigInt/)
    expect((await script('const a = {}; a.a = a; return a')).error).toMatch(/circular|cyclic/i)
  })

  it(`the ${RUN_CAP + 1}st script of a run is rate_limited and loads nothing`, async () => {
    const requested: string[] = []
    const ctx = await ctxFor({ onCodeRequested: id => requested.push(id) })
    for (let i = 0; i < RUN_CAP; i++) expect((await shopifyScriptRun.run(ctx, { code: 'return 1' })).ok).toBe(true)
    const n = requested.length
    const r = await shopifyScriptRun.run(ctx, { code: 'return "one more"' })
    expect(r).toMatchObject({ ok: false, error: { code: 'rate_limited', message: expect.stringContaining(RUN_CAP_MESSAGE) } })
    expect(requested.length).toBe(n)
    // A server job has its own run budget and shares the day's.
    expect((await shopifyScriptRun.run(await ctxFor({}, server), { code: 'return 1' })).ok).toBe(true)
  })
})

describe('A.7.7 the hub trusts nothing the sandbox returns', () => {
  const breakouts: [string, string][] = [
    ['closing the arrow, module code returns 9 KiB', `return 1\n}\nJSON.stringify = () => 'x'.repeat(9 * 1024)\nconst _rest = () => {`],
    ['JSON.stringify patched to an object', `JSON.stringify = () => ({ not: 'a string' }); return 1`],
    ['JSON.stringify patched to a function', `JSON.stringify = () => () => 1; return 1`],
    ['JSON.stringify patched to a stub', `const { RpcTarget } = await import('cloudflare:workers'); JSON.stringify = () => new RpcTarget(); return 1`],
    ['JSON.stringify patched to a number', `JSON.stringify = () => 42; return 1`],
  ]
  for (const [label, code] of breakouts) {
    it(label, async () => {
      expect((await script(code)).error).toBe(`Error: ${BAD_RETURN}`)
    })
  }
})

describe('A.7.8 late calls', () => {
  it('a call after the deadline is refused without reaching the upstream', async () => {
    let refused: () => void = () => {}
    const wasRefused = new Promise<void>(r => {
      refused = r
    })
    const { out } = await direct(
      `await new Promise(r => setTimeout(r, 1)); await shop.graphql(${PRODUCTS_PAGE}, { first: 1 }); return 1`,
      { setTimer: (_ms, fn) => (queueMicrotask(fn), () => {}) },
      { refused },
    )
    expect(out.outcome).toBe('timeout')
    await wasRefused
    expect(seen.graphql).toBe(0)
  })

  it('a shop kept on globalThis is closed on the next run of the same code', async () => {
    const code = `if (globalThis.kept) { ${catching(`globalThis.kept.graphql(${PRODUCTS_PAGE}, { first: 1 })`)} } globalThis.kept = shop; return 'stored'`
    expect((await script(code)).result).toBe('stored')
    const second = await script(code)
    expect(second.result).not.toBe('reached')
    expect(seen.graphql).toBe(0)
  })
})

describe('A.7.9 keyed by hash', () => {
  it('the same code twice asks the loader for code once; another code is another id', async () => {
    const asked: string[] = []
    await script('return "same"', { onCodeRequested: id => asked.push(id) })
    await script('return "same"', { onCodeRequested: id => asked.push(id) })
    expect(asked).toHaveLength(1)
    await script('return "samf"', { onCodeRequested: id => asked.push(id) })
    expect(asked).toHaveLength(2)
    expect(asked[0]).not.toBe(asked[1])
  })
})

describe('A.7.10 pause and readiness by account (through ReadGateway)', () => {
  it('pausing Shopify hides and refuses shopify_script_run with the six', async () => {
    const listed = async () => {
      const r = (await gateways.ReadGateway.listTools(run)) as HubResult<ToolInfo[]>
      if (!r.ok) throw new Error(r.error.code)
      return r.value.map(t => t.name)
    }
    expect(await listed()).toContain('shopify_script_run')
    expect(await gateways.ConnectGateway.setPaused(server, 'shopify:store', true)).toMatchObject({ ok: true })
    const after = await listed()
    expect(after).not.toContain('shopify_script_run')
    expect(after).not.toContain('orders_search')
    expect(await gateways.ReadGateway.callTool(run, 'shopify_script_run', { code: 'return 1' })).toMatchObject({ ok: false, error: { code: 'paused' } })
    expect(seen.graphql).toBe(0)
  })
})

describe('A.7.11 canary', () => {
  it('no result, error, log line or tool result ever carries the token, even stringifying shop', async () => {
    const CANARY = 'shpat_CANARY_W2_4f1e9b'
    install(CANARY)
    const code = `
const out = []
await shop.graphql(${PRODUCTS_PAGE}, { first: 1 })
out.push(String(shop), JSON.stringify(shop), Object.getOwnPropertyNames(shop).join(','), Object.getOwnPropertyNames(Object.getPrototypeOf(shop) ?? {}).join(','))
for (const k of ['token', 'accountId', 'env', 'client', 'apiVersion', 'calls', 'close', 'constructor']) {
  try { out.push(k + '=' + String(shop[k])) } catch (e) { out.push(k + '!' + e.message) }
}
try { await shop.graphql('{ orders(first: 1) { nodes { email } } }') } catch (e) { out.push(e.message) }
try { await shop.close() } catch (e) { out.push(e.message) }
return out`
    const r = await script(code)
    const failing = await script(`await shop.graphql(${PRODUCTS_PAGE}, { first: 1 }); throw new Error(JSON.stringify(shop))`)
    const all = JSON.stringify([r, failing]) + lines.join('\n')
    expect(realToken).not.toBe('')
    expect(seen.graphql).toBeGreaterThan(0)
    expect(all).not.toContain(CANARY)
    expect(all).not.toContain(realToken)
  })
})

describe('A.7.12 the S4 measurement in a real Dynamic Worker', () => {
  const expected: Record<string, unknown> = {
    'lowest-stock': lowestStock(d),
    'unfulfilled-3-days': unfulfilledOverThreeDays(d, ASKED_AT),
    'refunds-by-product-reason': refundsByProductAndReason(d),
    'open-returns-not-restocked': openReturnsNotRestocked(d),
  }
  for (const c of MEASURE_CASES) {
    it(`${c.id}: equals its oracle within ${MAX_ANSWER_BYTES} bytes`, async () => {
      const r = await script(c.code)
      expect(r.error).toBeUndefined()
      expect(r.result).toEqual(expected[c.id])
      const chars = JSON.stringify(r.result).length
      expect(new TextEncoder().encode(JSON.stringify(r.result)).byteLength).toBeLessThanOrEqual(MAX_ANSWER_BYTES)
      // The report's numbers: characters returned and wall time.
      console.info(`measure ${c.id}: ${chars} chars, ${r.calls} calls, ${r.ms} ms`)
    })
  }
})
