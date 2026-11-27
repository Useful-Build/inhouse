// Stage 1 M3-S2 (N21, N23, N24, section 0 Q1 and Q2): `shopify.inventory.restock`, `.reduce` and `shopify.refund.create`
// as `resolve` and `decideCore` take them. Ways it can go wrong, written first:
// - an argument outside the hub's strict shape gets through (a fraction, a reason from the other direction, a refund in
//   lower case, a delta, a transaction the agent made up);
// - a refund resolves in another currency than the shop's, or while the shop's currency isn't known;
// - a refund's units aren't its amount, so the ceiling's largest call doesn't bound it (`over_limit`);
// - a reduce or a refund runs under a grant, collects into a batch, or a member's refund is anything but `needs_admin`
//   (until M3-X);
// - a card or item line drops the amount, the currency, a line, the shipping, the restock or the customer's email.
import { describe, expect, it } from 'vitest'
import { decideCore } from '../../permissions/decide.ts'
import { POLICY_REV } from '../../permissions/policy.ts'
import { resolve } from '../../permissions/resolve.ts'
import type { CeilingFacts, DecideCtx, DecideFacts, GrantFacts, Resolved, ResolveFacts, WriteOperationKey } from '../../permissions/types.ts'
import { OPERATIONS } from './index.ts'
import { ReduceArgsSchema, RestockArgsSchema } from './shopify-inventory.ts'
import { moneyWords, RefundArgsSchema, type RefundArgs } from './shopify-refund-create.ts'

const facts = (currency: string | null = 'USD'): ResolveFacts => ({
  nowMs: 1,
  accounts: {
    shopify: { accountId: 'shopify:store', connectedAtMs: 10, connected: true, paused: false, label: 'Shopify (Store A)', shop: 'store-a', currency },
    slack: null,
  },
  listedChannels: [],
})

const ITEM = 'gid://shopify/InventoryItem/8001'
const LOCATION = 'gid://shopify/Location/601'
const stock = (o: Record<string, unknown> = {}) => ({ inventoryItemId: ITEM, locationId: LOCATION, quantity: 20, ...o })
const refund = (o: Partial<Record<keyof RefundArgs, unknown>> = {}) => ({
  orderId: 'gid://shopify/Order/1042', lines: [{ lineItemId: 'gid://shopify/LineItem/11', quantity: 2 }], amount: { minor: 2490, currency: 'USD' },
  restock: false, notifyCustomer: false, ...o,
})

describe('shopify.inventory.restock and .reduce', () => {
  it('take one item, one location, 1 to 1,000,000 whole units and a reason for their direction, nothing else', () => {
    expect(RestockArgsSchema.parse(stock())).toEqual({ ...stock(), reason: 'restock' })
    expect(RestockArgsSchema.parse(stock({ reason: 'received' })).reason).toBe('received')
    expect(ReduceArgsSchema.safeParse(stock({ reason: 'shrinkage' })).success).toBe(true)
    expect(ReduceArgsSchema.safeParse(stock()).success).toBe(false)
    for (const bad of [
      stock({ quantity: 0 }), stock({ quantity: -1 }), stock({ quantity: 1.5 }), stock({ quantity: 1_000_001 }), stock({ reason: 'damaged' }),
      stock({ reason: 'movement_created' }), stock({ inventoryItemId: 'gid://shopify/ProductVariant/1' }), stock({ locationId: '601' }),
      stock({ delta: 20 }), stock({ changeFromQuantity: 10 }), stock({ name: 'on_hand' }),
    ]) expect(RestockArgsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    expect(ReduceArgsSchema.safeParse(stock({ reason: 'restock' })).success).toBe(false)
  })

  it('resolve to the shop, one record, the quantity as units; their lines and cards name the item, place, change and reason', async () => {
    for (const [key, args, sign, verb] of [
      ['shopify.inventory.restock', stock(), '+', 'Add 20 units of stock to item 8001'],
      ['shopify.inventory.reduce', stock({ reason: 'damaged' }), '-', 'Remove 20 units of stock from item 8001'],
    ] as const) {
      expect(await resolve(facts(), { operation: key, args })).toMatchObject({ scope: { shop: 'store-a' }, scopeKey: 'shop=store-a', records: 1, units: 20 })
      const parsed = OPERATIONS[key].args.parse(args)
      expect(OPERATIONS[key].itemLine(parsed, facts())).toBe(`Item 8001 at location 601 (store-a): ${sign}20 (${key === 'shopify.inventory.restock' ? 'restock' : 'damaged'})`)
      expect(OPERATIONS[key].card(parsed, facts()).title).toBe(verb)
    }
  })

  it('restock: no effect, collects, N24\'s limits; reduce: destructive, never collects, no grant, 500 at most in one call', () => {
    expect(OPERATIONS['shopify.inventory.restock']).toMatchObject({
      unitsLabel: 'stock units', coalesces: true, memberMay: true, effects: { money: false, customer: false, destructive: false, access: false },
      defaults: { grant: { perDay: 200, unitsMax: 50 }, ceiling: { perDayMax: 1000, unitsMax: 500 } },
    })
    expect(OPERATIONS['shopify.inventory.reduce']).toMatchObject({
      unitsLabel: 'stock units', coalesces: false, memberMay: true, reversible: false, effects: { money: false, customer: false, destructive: true, access: false },
      defaults: { grant: null, ceiling: { unitsMax: 500 } },
    })
    expect(OPERATIONS['shopify.inventory.restock'].items).toBeUndefined()
  })
})

describe('shopify.refund.create', () => {
  const ok = (a: unknown) => RefundArgsSchema.safeParse(a).success
  it('takes an order, distinct lines or shipping, an exact amount in upper-case ISO 4217, restock and email flags, nothing else', () => {
    expect(ok(refund())).toBe(true)
    expect(ok(refund({ lines: [], shippingMinor: 500, amount: { minor: 500, currency: 'USD' } }))).toBe(true)
    for (const bad of [
      refund({ lines: [] }), refund({ lines: [], shippingMinor: 0 }), refund({ lines: [], shippingMinor: 500, restock: true }),
      refund({ lines: [{ lineItemId: 'gid://shopify/LineItem/11', quantity: 1 }, { lineItemId: 'gid://shopify/LineItem/11', quantity: 1 }] }),
      refund({ lines: [{ lineItemId: 'gid://shopify/LineItem/11', quantity: 0 }] }), refund({ amount: { minor: 0, currency: 'USD' } }),
      refund({ amount: { minor: 24.9, currency: 'USD' } }), refund({ amount: { minor: 2490, currency: 'usd' } }), refund({ amount: { minor: 2490 } }),
      refund({ amount: { minor: 1_000_000_001, currency: 'USD' } }), refund({ shippingMinor: -1 }), refund({ restock: undefined }),
      refund({ notifyCustomer: 'no' }), { ...refund(), transactions: [] }, { ...refund(), note: 'promised' }, { ...refund(), orderId: 'gid://shopify/Customer/1' },
    ]) expect(ok(bad), JSON.stringify(bad)).toBe(false)
  })

  it('resolves in the shop\'s currency with the amount as its units; another currency is invalid_args, an unknown one account_unavailable', async () => {
    expect(await resolve(facts(), { operation: 'shopify.refund.create', args: refund() })).toMatchObject({
      scope: { shop: 'store-a' }, records: 1, units: 2490, memberMay: false, effects: { money: true, customer: true, destructive: false, access: false },
    })
    expect(await resolve(facts('EUR'), { operation: 'shopify.refund.create', args: refund() })).toEqual({ refuse: { verdict: 'refuse', reason: 'invalid_args' } })
    expect(await resolve(facts(null), { operation: 'shopify.refund.create', args: refund() })).toEqual({ refuse: { verdict: 'refuse', reason: 'account_unavailable' } })
    // The other Shopify operations don't need the currency.
    expect(await resolve(facts(null), { operation: 'shopify.inventory.restock', args: stock() })).toMatchObject({ units: 20 })
  })

  it('says the amount, currency, lines, shipping, restock and whether the customer gets Shopify\'s email (N21\'s card)', () => {
    const e = OPERATIONS['shopify.refund.create']
    const a = RefundArgsSchema.parse(refund())
    expect(e.card(a, facts())).toEqual({
      title: 'Refund $24.90 (USD) on order 1042',
      lines: ['2 items, shipping $0.00.', '2 × line 11', 'Restock the items: no.', 'The customer gets Shopify’s refund email: no.'],
    })
    const b = RefundArgsSchema.parse(refund({ shippingMinor: 500, amount: { minor: 2990, currency: 'USD' }, restock: true, notifyCustomer: true }))
    expect(e.itemLine(b, facts())).toBe('Refund $29.90 (USD) on order 1042 (store-a); 2 × line 11; shipping $5.00; restock: yes; refund email: yes')
    expect(e.amount!(b, facts())).toEqual({ minor: 2990, currency: 'USD' })
    expect(moneyWords({ minor: 2490, currency: 'JPY' })).toBe('¥2,490')
    expect(moneyWords({ minor: 1234, currency: 'KWD' })).toMatch(/^KWD\s1\.234$/)
  })

  it('is money and the customer, admins only, never collected, no grant, $500 at most in one call', () => {
    expect(OPERATIONS['shopify.refund.create']).toMatchObject({
      coalesces: false, memberMay: false, reversible: false, defaults: { grant: null, ceiling: { unitsMax: 50_000 } },
    })
  })
})

describe('decideCore on the new operations (N23; M3-X changes only the member refund)', () => {
  const ceiling = (o: Partial<CeilingFacts> = {}): CeilingFacts => ({ enabled: true, perDayMax: 1000, loweredRev: 1, unitsMax: 500, bulkThreshold: 5, batchMax: 500, rev: 1, ...o })
  const ctx = (role: 'member' | 'admin'): DecideCtx => ({ asker: { memberId: 'm_asker', role }, origin: 'chat', chatId: 'c_1', nowMs: 1 })
  const grant = (r: Resolved): GrantFacts => ({
    id: 'pg_AAAAAAAAAAAAAAAAAAAAAA', holder: 'member:m_asker', accountId: r.accountId, accountGen: r.accountGen, operation: r.operation, scopeKey: r.scopeKey,
    perDay: 200, unitsMax: 50, policyRev: POLICY_REV, grantedRole: 'member', ceilingRev: 1, revokedAtMs: null,
  })
  const decide = async (operation: WriteOperationKey, args: unknown, role: 'member' | 'admin', c: Partial<CeilingFacts> = {}, withGrant = true) => {
    const r = await resolve(facts(), { operation, args })
    if ('refuse' in r) throw new Error('did not resolve')
    const f: DecideFacts = { ceiling: { [operation]: ceiling(c) }, grants: withGrant ? [grant(r)] : [], allowOnceCount: 0 }
    return decideCore(f, ctx(role), r)
  }

  it('a restock within its grant runs; past the grant\'s largest call it\'s an exact count card', async () => {
    expect(await decide('shopify.inventory.restock', stock({ quantity: 50 }), 'member')).toEqual({ verdict: 'run', grantId: 'pg_AAAAAAAAAAAAAAAAAAAAAA' })
    expect(await decide('shopify.inventory.restock', stock({ quantity: 51 }), 'member')).toEqual({ verdict: 'exact', guardrail: 'count', approver: 'asker' })
  })

  it('a reduce is always exact, whoever asks and whatever grant exists', async () => {
    for (const role of ['member', 'admin'] as const) {
      expect(await decide('shopify.inventory.reduce', stock({ quantity: 1, reason: 'damaged' }), role)).toEqual({ verdict: 'exact', guardrail: 'destructive', approver: 'asker' })
    }
  })

  it('a member\'s refund is refused needs_admin; an admin\'s is an exact money card; over the ceiling\'s largest call is over_limit', async () => {
    expect(await decide('shopify.refund.create', refund(), 'member', { unitsMax: 50_000 })).toEqual({ verdict: 'refuse', reason: 'needs_admin' })
    expect(await decide('shopify.refund.create', refund(), 'admin', { unitsMax: 50_000 })).toEqual({ verdict: 'exact', guardrail: 'money', approver: 'asker' })
    const big = refund({ amount: { minor: 50_001, currency: 'USD' } })
    for (const role of ['member', 'admin'] as const) {
      expect(await decide('shopify.refund.create', big, role, { unitsMax: 50_000 })).toEqual({ verdict: 'refuse', reason: 'over_limit' })
    }
    expect(await decide('shopify.inventory.reduce', stock({ quantity: 501, reason: 'damaged' }), 'admin')).toEqual({ verdict: 'refuse', reason: 'over_limit' })
  })

  it('nothing runs while its ceiling row is off or absent (no deployable build has one)', async () => {
    for (const [op, args] of [['shopify.inventory.restock', stock()], ['shopify.inventory.reduce', stock({ reason: 'damaged' })], ['shopify.refund.create', refund()]] as const) {
      expect(await decide(op, args, 'admin', { enabled: false })).toEqual({ verdict: 'refuse', reason: 'over_ceiling' })
      const r = await resolve(facts(), { operation: op, args })
      if ('refuse' in r) throw new Error('did not resolve')
      expect(decideCore({ ceiling: {}, grants: [], allowOnceCount: 0 }, ctx('admin'), r)).toEqual({ verdict: 'refuse', reason: 'over_ceiling' })
    }
  })
})
