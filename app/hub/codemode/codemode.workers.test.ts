// Code mode on workerd (P5 W2, A.7.3 to A.7.12; CI, the test config): real Dynamic Workers through env.LOADER, the
// real Shopify SignIn on SQLite and the recorded fixture upstream through H0's seam. Needs the orchestrator's lines:
// `worker_loaders` (LOADER) in wrangler.hub.test.jsonc, `codeModeConnector` in connectors/index.ts (test 10) and the
// index.ts wiring (ReadGateway passes codemode). Tests 3 to 9, 11 and 12 build code mode themselves over env.LOADER.
// The never-settling deadline case lives in codemode-deadline.workers.test.ts: its sandbox call stays pending, and a
// `reset()` after it crashes workerd ("Promise callback destroyed itself"), so no test may follow it in a file.
//
// Failure modes: the RpcTarget never reaches the sandbox (3); a script reaches the network (4) or writes, reads a
// protected field or filters on one (5); a cap doesn't hold (6); the hub trusts what the sandbox returns (7); a late
// call or a kept `shop` reaches Shopify (8); the id passed to the loader depends on more than the code (9); pause or readiness doesn't
// cover the tool (10); the token leaks anywhere (11); the S4 answers drift (12).
import { env, reset } from 'cloudflare:test'
import { exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountSummary, CallerScope, ConnectGateway, HubResult, ReadGateway, ToolInfo } from '../index/contract'
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

// Every test fails fast on a hung RPC instead of eating the CI job (B2, 2026-11-21); the measurement cases get 15 s.
vi.setConfig({ testTimeout: 10_000 })

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

/** What the second run sees calling a kept `shop`: the runtime's disposed-stub error (seen locally), or ScriptApi's own. */
const KEPT_REFUSAL = /^found kept: (RPC stub used after being disposed\.|shop is closed: the script has finished or ran out of time)$/

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
  // Review H1: variables are plain JSON within 16 KiB and declared by the operation; nothing else reaches the hub's
  // JSON.stringify or Shopify.
  for (const [label, vars] of [
    ['a junk undeclared variable', `{ junk: 'x'.repeat(1000) }`],
    ['a function variable', `{ q: () => 'sku:"a"' }`],
    ['a toJSON callback', `{ q: { toJSON() { globalThis.called = true; return 'sku:"a"' } } }`],
    ['an oversize variable', `{ q: 'x'.repeat(20000) }`],
    // Defence in depth: SignIn.query refuses a top-level array before checkVariables (core.ts), and so does ScriptApi.
    ['an array with a toJSON as the whole variables', `Object.assign(['a'], { toJSON() { globalThis.called = true; return {} } })`],
  ] as const) {
    it(`${label} is refused before Shopify`, async () => {
      const doc = 'query Q($q: String) { orders(first: 1, query: $q) { nodes { id } } }'
      const r = await script(`${catching(`shop.graphql(${JSON.stringify(doc)}, ${vars})`)}`)
      expect(r.result).toMatch(/^invalid_args: /)
      expect(seen.graphql).toBe(0)
    })
  }
  // Review round 2 (H1b, L2): cases only checkVariables catches. A `toJSON` on an array (named own props survive RPC)
  // or on a declared but unused variable passes the field check, so without checkVariables the hub's JSON.stringify
  // would call it back into the sandbox.
  const UNUSED = 'query Q($q: String, $z: [String], $o: OrderInput) { orders(first: 1, query: $q) { nodes { id } } }'
  for (const [label, vars] of [
    ['an array with a toJSON, nested under a declared unused object variable', `{ q: 'sku:"a"', o: { list: Object.assign(['a'], { toJSON() { globalThis.called = true; return ['a'] } }) } }`],
    ['an array with a toJSON, nested in a declared unused variable', `{ q: 'sku:"a"', z: Object.assign(['a'], { toJSON() { globalThis.called = true; return ['a'] } }) }`],
    ['a toJSON on a declared unused variable', `{ q: 'sku:"a"', z: { toJSON() { globalThis.called = true; return ['a'] } } }`],
  ] as const) {
    it(`${label} is refused, never called, nothing upstream`, async () => {
      const r = await script(`globalThis.called = false; let msg = 'reached'; try { await shop.graphql(${JSON.stringify(UNUSED)}, ${vars}) } catch (e) { msg = e.message } return { msg, called: globalThis.called }`)
      expect(r.result).toEqual({ msg: 'invalid_args: invalid arguments', called: false })
      expect(seen.graphql).toBe(0)
    })
  }

  it('a toJSON callback is never called back from the hub', async () => {
    const doc = 'query Q($q: String) { orders(first: 1, query: $q) { nodes { id } } }'
    const r = await script(`try { await shop.graphql(${JSON.stringify(doc)}, { q: { toJSON() { globalThis.called = true; return 'sku:"a"' } } }) } catch {} return globalThis.called === true`)
    expect(r.result).toBe(false)
  })

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

  // Change to the brief's test 6 (B2, 2026-11-21): local workerd doesn't enforce `limits.cpuMs` on a Dynamic Worker, and
  // an infinite loop blocks the thread the hub and the runner share, so no timer (the deadline, vitest's) can fire.
  // The loop itself is checked at the P5 live check on the deployed hub. Here: the limits the hub asks for, and a
  // bounded CPU script that completes.
  it('opens the entrypoint with the CPU and subrequest limits, and a bounded CPU script completes', async () => {
    const asked: unknown[] = []
    const loader: WorkerLoader = {
      get: (id, cb) => {
        const worker = LOADER.get(id, cb)
        return {
          getEntrypoint: (name, options) => {
            asked.push({ name, options })
            return worker.getEntrypoint(name, options)
          },
          getDurableObjectClass: (name, options) => worker.getDurableObjectClass(name, options),
        }
      },
      load: () => {
        throw new Error('code mode never calls load()')
      },
    }
    const r = await script('let x = 0; for (let i = 0; i < 2e6; i++) x = (x + i) % 1000003; return x', { loader })
    expect(r.error).toBeUndefined()
    expect(typeof r.result).toBe('number')
    expect(asked).toEqual([{ name: 'Script', options: { limits: { cpuMs: 1_000, subRequests: 20 } } }])
  })

  it('the wrapper refuses a big or non-string return inside the sandbox, before it crosses (review L1/L3)', async () => {
    for (const code of [`return 'x'.repeat(9000)`, 'return () => 1']) {
      const { out } = await direct(code)
      expect(out, code).toMatchObject({ outcome: 'error', error: `Error: ${BAD_RETURN}` })
    }
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
    // The second run reports that it found the kept object (a marker), then the refusal it got (review L4).
    const code = `if (globalThis.kept) { try { await globalThis.kept.graphql(${PRODUCTS_PAGE}, { first: 1 }); return 'reached' } catch (e) { return 'found kept: ' + e.message } } globalThis.kept = shop; return 'stored'`
    expect((await script(code)).result).toBe('stored')
    const second = await script(code)
    expect(second.result).toMatch(KEPT_REFUSAL)
    expect(seen.graphql).toBe(0)
  })
})

describe('A.7.9 keyed by hash', () => {
  // The loader's cache isn't guaranteed (docs: api-reference), so this asserts what the hub controls: the id it passes,
  // not how often the callback runs (B2, 2026-11-21).
  it('the same code passes the same id each time and answers right both times; another code is another id', async () => {
    const ids: string[] = []
    const loader: WorkerLoader = {
      get: (id, cb) => {
        ids.push(id ?? '')
        return LOADER.get(id, cb)
      },
      load: () => {
        throw new Error('code mode never calls load()')
      },
    }
    expect((await script('return "same"', { loader })).result).toBe('same')
    expect((await script('return "same"', { loader })).result).toBe('same')
    expect((await script('return "samf"', { loader })).result).toBe('samf')
    expect(ids).toHaveLength(3)
    expect(ids[0]).toMatch(/^cm1-[0-9a-f]{64}$/)
    expect(ids[1]).toBe(ids[0])
    expect(ids[2]).not.toBe(ids[0])
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

// P4's test shop override (index/test-shop.ts) holds for code mode too (P5 main merge). This project is the hub's test
// build; the deployable build's refusal is index/test-shop.test.ts. Failure modes: a script's shop.graphql reaches
// SHOPIFY_SHOP while a test shop is set, or an override the hub can't honour still runs the script.
describe('the test shop override (through ReadGateway)', () => {
  const OTHER = 'example-mc-codemode-check.myshopify.com'
  let otherGraphql = 0
  let otherOther = 0
  beforeEach(() => {
    otherGraphql = 0
    otherOther = 0
    const base = createShopifyUpstream(dataset)
    testUpstreams.set(OTHER, async req => {
      if (new URL(req.url).pathname.endsWith('/graphql.json')) otherGraphql++
      else otherOther++
      return base(req)
    })
  })
  afterEach(() => {
    testUpstreams.delete(OTHER)
  })
  const code = `const r = await shop.graphql(${PRODUCTS_PAGE}, { first: 1 }); return r.data.products.nodes.length`

  it('a registered test shop is what the script reads; SHOPIFY_SHOP is never reached', async () => {
    const r = (await gateways.ReadGateway.callTool(run, 'shopify_script_run', { code }, { testShopHost: OTHER })) as HubResult<{ data: { result?: unknown; error?: string } }>
    expect(r).toMatchObject({ ok: true, value: { data: { result: 1 } } })
    expect(otherGraphql).toBe(1)
    expect(seen.graphql).toBe(0)
    // Without the option the same script reads the configured shop.
    expect(await gateways.ReadGateway.callTool(run, 'shopify_script_run', { code })).toMatchObject({ ok: true, value: { data: { result: 1 } } })
    expect(seen.graphql).toBe(1)
    expect(otherGraphql).toBe(1)
  })

  // #337 review (Sonnet L3): a test-shop read asks the test shop's own SignIn object whether it's ready, never the real
  // account's, so pausing the real account neither blocks nor changes a test-shop read (and the real shop stays unread).
  it('with the real account paused, a registered test shop still reads; without the option the call is paused', async () => {
    expect(await gateways.ConnectGateway.setPaused(server, 'shopify:store', true)).toMatchObject({ ok: true })
    expect(await gateways.ReadGateway.callTool(run, 'shopify_script_run', { code }, { testShopHost: OTHER })).toMatchObject({ ok: true, value: { data: { result: 1 } } })
    expect(otherGraphql).toBe(1)
    expect(await gateways.ReadGateway.callTool(run, 'shopify_script_run', { code })).toMatchObject({ ok: false, error: { code: 'paused' } })
    expect(seen.graphql).toBe(0)
  })

  // #337 round 2 (Opus H1): the prompt's account read resolves through the test shop like the reads do, so the turn's
  // "Connected apps" line names Shopify when the test shop will serve it, whatever the real account's object says (empty
  // here, or paused). The test shop's object is granted first (its token endpoint only, no GraphQL read).
  it('listAccounts with a registered test shop reports Shopify from the test shop: connected, even with the real account empty or paused', async () => {
    const shopify = (rows: AccountSummary[]) => rows.find(r => r.accountId === 'shopify:store')!
    const plain = (await gateways.ConnectGateway.listAccounts(server)) as HubResult<AccountSummary[]>
    if (!plain.ok) throw new Error(plain.error.code)
    expect(shopify(plain.value).status.state).toBe('empty')
    for (const pause of [false, true]) {
      if (pause) expect(await gateways.ConnectGateway.setPaused(server, 'shopify:store', true)).toMatchObject({ ok: true })
      const r = (await gateways.ConnectGateway.listAccounts(server, { testShopHost: OTHER })) as HubResult<AccountSummary[]>
      if (!r.ok) throw new Error(r.error.code)
      expect(shopify(r.value), `real paused ${pause}`).toMatchObject({ configured: true, status: { state: 'active', paused: false, needsReconnect: false } })
    }
    expect(otherGraphql).toBe(0)
    expect(seen.graphql).toBe(0)
    // An override the hub can't honour is refused, never answered from the real account.
    expect(await gateways.ConnectGateway.listAccounts(server, { testShopHost: 'example-mc-not-registered.myshopify.com' })).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
  })

  // #337 round 3 (L5): the caller's scope is checked before the test shop's object is granted: a run scope (the runner's)
  // is refused and reaches no upstream, not even the token endpoint.
  it('listAccounts with a test shop refuses a run scope before any grant', async () => {
    expect(await gateways.ConnectGateway.listAccounts(run, { testShopHost: OTHER })).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    expect(otherOther + otherGraphql).toBe(0)
  })

  it('an unregistered or malformed test shop is invalid_args before the script runs, and no shop is read', async () => {
    for (const options of [{ testShopHost: 'example-mc-not-registered.myshopify.com' }, { testShopHost: 'evil.example' }, 'x']) {
      expect(await gateways.ReadGateway.callTool(run, 'shopify_script_run', { code }, options as never), JSON.stringify(options)).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    }
    expect(seen.graphql + otherGraphql).toBe(0)
    expect(lines.some(l => l.includes('hub_codemode'))).toBe(false)
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

describe('A.7.12 the S4 measurement in a real Dynamic Worker', { timeout: 15_000 }, () => {
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
