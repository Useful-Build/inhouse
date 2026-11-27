// The graded morning-check set's datasets, oracle and faults (P4 W3 PR 2; p4-w3.md section 6). Ways it can fail, written
// down first:
//  1. a dataset plants a problem the literal expectations don't list, or misses one they do (checked against an oracle
//     that applies B2's eight rules in plain code, never against the same list);
//  2. the answer depends on the day the set is run (every age is relative, so any `now` must give the same keys);
//  3. a clean store crosses a rule;
//  4. an outage fault doesn't reach the hub as its code: credentials_rejected, result_too_large, upstream_unavailable;
//  4b. an outage fault stops the hub's first grant, so the store reads as never connected (route 70 lists it in the catalog,
//      the prompt doesn't name it) and the graded run's store check stops before the case, instead of running a connected
//      store that's down (the 2026-11-26 eval run stopped at outage-all for this);
//  5. a dataset isn't well-formed, or two cases share a host.
import { describe, expect, it } from 'vitest'
import { AMBER, GAPS, META, OPERATIONS_OF, RED } from '../../../evals/morning-check/expected'
import { CASES } from '../../../test/upstreams/morning-check/cases'
import { DAY, HOUR, fixtureStore, healthy } from '../../../test/upstreams/morning-check/datasets'
import { expectedFindings } from '../../../test/upstreams/morning-check/oracle'
import { MORNING_CHECK_UPSTREAMS, hostOf, lazyUpstream, morningCheckUpstreams, upstreamFor, withFault } from '../../../test/upstreams/morning-check/upstreams'
import { checkDataset } from '../../../test/upstreams/shopify/dataset'
import { createShopifyUpstream, TEST_CLIENT_ID, TEST_CLIENT_SECRET } from '../../../test/upstreams/shopify/server'
import { shopifyConnector } from './route'
import { call, signInClient } from './test-kit'

const NOW = Date.parse('2026-11-22T12:00:00Z')
const FROM = { createdFrom: '2026-01-01T00:00:00Z' }
const sevOf = (s: 'amber' | 'red') => (s === 'red' ? RED : AMBER)

describe('the cases', () => {
  it('has 12 graded, 3 clean and 3 outage cases, with unique ids and hosts', () => {
    expect(CASES.filter(c => c.group === 'graded')).toHaveLength(12)
    expect(CASES.filter(c => c.group === 'clean')).toHaveLength(3)
    expect(CASES.filter(c => c.group === 'outage')).toHaveLength(3)
    expect(new Set(CASES.map(c => c.id)).size).toBe(CASES.length)
    expect(new Set(CASES.map(c => hostOf(c.id))).size).toBe(CASES.length)
    expect(Object.keys(MORNING_CHECK_UPSTREAMS).sort()).toEqual(CASES.map(c => hostOf(c.id)).sort())
    expect(META.map(m => m.id)).toEqual(CASES.map(c => c.id))
  })

  it('every dataset is a well-formed dataset', () => {
    for (const c of CASES) expect(() => checkDataset(c.build(NOW)), c.id).not.toThrow()
  })

  for (const c of CASES.filter(x => !(x.fault && x.fault.ops === 'all'))) {
    it(`${c.id}: the literal expectations equal what the eight rules find`, () => {
      const found = expectedFindings(c.build(NOW), NOW)
      expect(found.map(f => [f.key, sevOf(f.sev)]).sort()).toEqual(c.items.map(i => [i.key, i.sev]).sort())
      for (const want of c.items) {
        const have = found.find(f => f.key === want.key)!.sources
        for (const name of want.sources) expect(Array.isArray(name) ? name.some(n => have.includes(n)) : have.includes(name as string), `${c.id} ${want.key} ${String(name)}`).toBe(true)
      }
    })

    it(`${c.id}: the same findings on any day and hour`, () => {
      const keys = (now: number) => expectedFindings(c.build(now), now).map(f => `${f.key}:${f.sev}`).sort()
      const base = keys(NOW)
      for (const shift of [-90 * DAY, -3 * HOUR, 5 * HOUR + 17 * 60_000, 11 * DAY, 400 * DAY + 7 * HOUR]) expect(keys(NOW + shift), `${c.id} at ${shift}`).toEqual(base)
    })
  }

  it('the clean stores and the healthy store have no findings', () => {
    for (const c of CASES.filter(x => x.group === 'clean')) expect(expectedFindings(c.build(NOW), NOW), c.id).toEqual([])
    expect(expectedFindings(healthy(NOW), NOW)).toEqual([])
  })
})

describe('datasets are built at the first request, with the clock then', () => {
  it('does not read the clock until a request comes, and reads it once', async () => {
    let reads = 0
    const ups = morningCheckUpstreams(() => (++reads, NOW))
    expect(reads).toBe(0)
    const host = hostOf('late-orders')
    const probe = () => ups[host]!(new Request(`https://${host}/admin/oauth/access_token`, { method: 'POST', body: 'grant_type=x' }))
    await probe()
    await probe()
    expect(reads).toBe(1)
  })

  it('a dataset built at the epoch (what a module evaluated in workerd would get) reads differently from one built now', () => {
    const c = CASES.find(x => x.id === 'late-orders')!
    // Built now: the three orders are 5 to 6 days old, amber. Built at 0 and read now: decades old, so red.
    expect(expectedFindings(c.build(NOW), NOW).map(f => `${f.key}:${f.sev}`)).toEqual(['late-orders:amber'])
    expect(expectedFindings(c.build(0), NOW).map(f => `${f.key}:${f.sev}`)).toEqual(['late-orders:red'])
    expect(MORNING_CHECK_UPSTREAMS[hostOf('late-orders')]).toBeTypeOf('function')
    expect(lazyUpstream(c, () => NOW)).toBeTypeOf('function')
  })
})

describe('the time-shifted fixture', () => {
  it('keeps its relative ages: 5.3 days for #1001, and the refunds a few hours old', () => {
    const d = fixtureStore(NOW)
    const first = d.orders.find(o => o.name === '#1001')!
    expect(((NOW - Date.parse(first.processedAt)) / DAY).toFixed(1)).toBe('5.3')
    const refunds = d.orders.flatMap(o => o.refunds.map(r => Date.parse(r.createdAt!)))
    expect(refunds).toHaveLength(21)
    expect(refunds.every(t => NOW - t > 0 && NOW - t < DAY)).toBe(true)
  })

  it('finds what was checked by hand: late-orders (#1001), refund-spike (21 refunds) and oversold (P4-0038), nothing else', () => {
    const found = expectedFindings(fixtureStore(NOW), NOW)
    expect(found.map(f => f.key)).toEqual(['late-orders', 'refund-spike', 'oversold'])
    expect(found[0]!.sources).toEqual(['#1001'])
    expect(found[1]!.sources).toHaveLength(21)
    expect(found[2]!.sources).toEqual(['P4-0038'])
  })
})

// The refund-spike rule is read through refunds_search, which asks only for refunded or partially refunded orders updated in
// its window (as Shopify marks an order when it refunds it). A dataset whose refunds sit on orders marked paid, or last
// updated before the refund, would hide them from the check whatever the model did.
describe('refunds_search, through the hub\'s own tools, returns every refund the eight rules count', () => {
  const iso = (ms: number) => new Date(ms).toISOString()
  async function refunds(c: (typeof CASES)[number], fromMs: number): Promise<string[]> {
    const client = signInClient(upstreamFor(c, NOW)).client
    const seen: string[] = []
    let after: string | null = null
    do {
      const r = await call('refunds_search', { createdFrom: iso(fromMs), ...(after === null ? {} : { after }) }, client, NOW)
      if (!r.ok) throw new Error(`${c.id} refunds_search: ${r.error.code}`)
      const v = r.value as { items: { orderName: string; createdAt: { ms: number } }[]; nextCursor: string | null }
      for (const i of v.items) seen.push(`${i.orderName}@${i.createdAt.ms}`)
      after = v.nextCursor
    } while (after !== null)
    return seen.sort()
  }
  const inDataset = (c: (typeof CASES)[number], fromMs: number) =>
    c.build(NOW).orders.flatMap(o => o.refunds.filter(r => Date.parse(r.createdAt!) >= fromMs).map(r => `${o.name}@${Date.parse(r.createdAt!)}`)).sort()

  for (const c of CASES.filter(x => !x.fault)) {
    it(`${c.id}: the last 24 h and the 14 days before, as the dataset holds them`, async () => {
      for (const from of [NOW - DAY, NOW - 15 * DAY]) expect(await refunds(c, from), `${c.id} from ${iso(from)}`).toEqual(inDataset(c, from))
    })
  }

  it('refund-spike: the four orders the spike names come back for the last 24 h, refunded and updated at refund time', async () => {
    const c = CASES.find(x => x.id === 'refund-spike')!
    const names = [...new Set((await refunds(c, NOW - DAY)).map(k => k.split('@')[0]))]
    expect(names).toEqual(['#2051', '#2052', '#2053', '#2054'])
    for (const o of c.build(NOW).orders.filter(x => names.includes(x.name))) {
      expect(['REFUNDED', 'PARTIALLY_REFUNDED'], o.name).toContain(o.displayFinancialStatus)
      expect(o.updatedAt, o.name).toBe(o.refunds[0]!.createdAt)
    }
  })
})

describe('the outage upstreams, through the hub\'s own tools', () => {
  const lateOrders = CASES.find(c => c.id === 'outage-credentials')!
  const client = (id: string) => signInClient(upstreamFor(CASES.find(c => c.id === id)!, NOW)).client

  it('outage-all: every read is upstream_unavailable', async () => {
    const c = client('outage-all')
    for (const [tool, input] of [['orders_search', { first: 5 }], ['refunds_search', { first: 5, ...FROM }], ['returns_search', { first: 5 }], ['products_search', { first: 5 }]] as const) {
      expect(await call(tool, input, c), tool).toMatchObject({ ok: false, error: { code: 'upstream_unavailable' } })
    }
  })

  it('outage-credentials: refunds_search is credentials_rejected, reads before it answered, and the account then stays rejected', async () => {
    const c = client('outage-credentials')
    expect(await call('orders_search', { first: 5 }, c)).toMatchObject({ ok: true })
    expect(await call('refunds_search', { first: 5, ...FROM }, c)).toMatchObject({ ok: false, error: { code: 'credentials_rejected' } })
    // The sign-in marks the account failed on a rejected token: every later read is credentials_rejected too, so which reads
    // succeed depends on the model's order. The case is `lenient` for that reason (expected.ts).
    expect(await call('orders_search', { first: 5 }, c)).toMatchObject({ ok: false, error: { code: 'credentials_rejected' } })
    expect(lateOrders.fault).toEqual({ kind: 'credentials_rejected', ops: ['RefundsSearch'] })
    expect(lateOrders.lenient).toBe(true)
  })

  it('outage-too-large: returns_search is result_too_large, the other reads still answer', async () => {
    const c = client('outage-too-large')
    expect(await call('returns_search', { first: 5 }, c)).toMatchObject({ ok: false, error: { code: 'result_too_large' } })
    expect(await call('orders_search', { first: 5 }, c)).toMatchObject({ ok: true })
    expect(await call('refunds_search', { first: 5, ...FROM }, c)).toMatchObject({ ok: true })
  })

  // 4b. The product's store check (evals/shopify-served.ts on route 70, server/api/tools.ts) and the prompt's account read
  // (hub/oauth/entry.ts listAccounts) both need the test shop's first grant to work: SignIn's `warm`, then an account
  // that is `active` with a connect date. Every outage case is a connected store that's down, never one never connected.
  for (const c of CASES.filter(x => x.group === 'outage')) {
    it(`${c.id}: the first grant works, so the account reads active with a connect date before any read`, async () => {
      const { core } = signInClient(upstreamFor(c, NOW))
      expect(await core.warm(shopifyConnector.accountId)).toEqual({ ok: true, value: { state: 'active' } })
      expect(await core.accountStatus(shopifyConnector.accountId)).toMatchObject({ ok: true, value: { state: 'active', paused: false, lastError: null, connectedAt: { ms: expect.any(Number) } } })
    })
  }

  it('outage-all: the token endpoint grants and every GraphQL read answers 503, whatever its operation', async () => {
    const host = hostOf('outage-all')
    const up = upstreamFor(CASES.find(c => c.id === 'outage-all')!, NOW)
    const token = await up(new Request(`https://${host}/admin/oauth/access_token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: TEST_CLIENT_ID, client_secret: TEST_CLIENT_SECRET }) }))
    expect(token.status).toBe(200)
    const { access_token } = (await token.json()) as { access_token: string }
    for (const query of ['query OrdersSearch { orders(first: 1) { nodes { id } } }', 'query ShopName { shop { name } }', '{ shop { name } }', 'not graphql']) {
      const r = await up(new Request(`https://${host}/admin/api/2026-10/graphql.json`, { method: 'POST', headers: { 'X-Shopify-Access-Token': access_token, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) }))
      expect(r.status, query).toBe(503)
    }
  })

  it('outage-all: after the grant, every read is still upstream_unavailable and the account keeps its connect date', async () => {
    const { client: c, core } = signInClient(upstreamFor(CASES.find(x => x.id === 'outage-all')!, NOW))
    expect(await core.warm(shopifyConnector.accountId)).toMatchObject({ ok: true })
    for (const [tool, input] of [['orders_search', { first: 5 }], ['refunds_search', { first: 5, ...FROM }], ['returns_search', { first: 5 }], ['products_search', { first: 5 }]] as const) {
      expect(await call(tool, input, c), tool).toMatchObject({ ok: false, error: { code: 'upstream_unavailable' } })
    }
    expect(await core.accountStatus(shopifyConnector.accountId)).toMatchObject({ ok: true, value: { connectedAt: { ms: expect.any(Number) } } })
  })

  it('a fault names only operations the gaps map to, and each gap maps to the operation its tool uses', () => {
    const known = new Set(Object.values(OPERATIONS_OF).flat())
    for (const c of CASES) if (c.fault && c.fault.ops !== 'all') for (const op of c.fault.ops) expect(known.has(op), `${c.id} ${op}`).toBe(true)
    expect(OPERATIONS_OF.refunds).toEqual(['RefundsSearch'])
    expect(OPERATIONS_OF.returns).toEqual(['ReturnsSearch'])
    expect(GAPS).toEqual(['orders', 'products', 'inventory', 'refunds', 'returns'])
  })

  it('a faultless wrapper changes nothing: the same answer as the plain upstream', async () => {
    const plain = signInClient(createShopifyUpstream(CASES[0]!.build(NOW))).client
    const wrapped = signInClient(withFault(createShopifyUpstream(CASES[0]!.build(NOW)), { kind: 'oversize', ops: ['NoSuchOperation'] })).client
    expect(await call('orders_search', { first: 5 }, wrapped)).toEqual(await call('orders_search', { first: 5 }, plain))
  })
})
