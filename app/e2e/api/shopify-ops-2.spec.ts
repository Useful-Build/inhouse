// Stage 1 M3-S2's done-when (N21): restock, reduce and refund work end to end through the test-fakes `action` op (the
// outbox's own `request` through the egress's `actions` handler, as an active person), their routes and BrandAgent's
// send through `HUB_WRITE` into the hub's fake Shopify write store. No container. Oracles, the plan's words written out:
//  - a restock is an `ask` card; allowed once, it goes out once after its hold with the action's idempotency key;
//  - a reduce is an exact `destructive` card every time, which its asker approves;
//  - a member's refund is an exact `money` card for any admin (M3-X; admin-cards.spec.ts has the rest); an admin's is an
//    exact `money` card to themselves; approved, it goes out
//    once with the amount explicit in its transaction, after Shopify's suggested refund matched it;
//  - a refund in another currency than the shop's (which the hub's connect/status answer names, copied into D1) is
//    refused at `resolve`, and one past the ceiling's largest call `over_limit`;
//  - with the operations off, every request is refused `over_ceiling`.
// The ceiling is set only through the hook and turned off again after (and before, in case a killed run left it on).
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { actor, call, me } from './kit.ts'
import { readSql } from './db.ts'
import { hook, hubCall, SHOPIFY_ACCOUNT } from './fakes-kit.ts'

const dana = actor('memberA')
const admin = actor('admin')
test.describe.configure({ mode: 'serial' })

const RESTOCK = 'shopify.inventory.restock'
const REDUCE = 'shopify.inventory.reduce'
const REFUND = 'shopify.refund.create'
const OPS = [RESTOCK, REDUCE, REFUND] as const
type Op = (typeof OPS)[number]

const ITEM = 'gid://shopify/InventoryItem/8001'
const LOCATION = 'gid://shopify/Location/601'
/** Order 9001's unfulfilled line in the fake: $5.00 a unit, three units. */
const refundArgs = (o: Record<string, unknown> = {}) => ({
  orderId: 'gid://shopify/Order/9001', lines: [{ lineItemId: 'gid://shopify/LineItem/90012', quantity: 1 }], amount: { minor: 500, currency: 'USD' },
  restock: false, notifyCustomer: false, ...o,
})

let danaId = ''
let adminId = ''

interface StoreWrite { operation: string; variables: Record<string, any>; outcome: string }
const storeWrites = async (request: APIRequestContext, op: Op): Promise<StoreWrite[]> => {
  const r = await hook(request, { op: 'state' })
  expect(r.status, r.text).toBe(200)
  return (r.json.shopifyWrite as { writes: StoreWrite[] }).writes.filter(w => w.operation === op)
}
const ceiling = async (request: APIRequestContext, operation: Op, enabled: boolean) => {
  const r = await hook(request, { op: 'ceiling', operation, enabled, perDayMax: 1000, unitsMax: operation === REFUND ? 50_000 : 500 })
  expect(r.status, r.text).toBe(200)
}
const requestAction = async (request: APIRequestContext, memberId: string, operation: Op, args: Record<string, unknown>) => {
  const r = await hook(request, { op: 'action', as: { memberId }, operation, args })
  expect(r.status, r.text).toBe(200)
  return r.json.result as { outcome: string; reason?: string; action?: Record<string, any> }
}
const card = async (request: APIRequestContext, who: typeof dana, id: string) => {
  const r = await call(request, who, 'GET', `/api/actions/${id}`)
  expect(r.status, r.text).toBe(200)
  return r.json as { id: string; rev: number; state: string; result?: string }
}
const answer = async (request: APIRequestContext, who: typeof dana, id: string, choice: 'once' | 'approve') => {
  const r = await call(request, who, 'POST', `/api/actions/${id}/answer`, { json: { choice, ifRev: (await card(request, who, id)).rev } })
  expect(r.status, r.text).toBe(200)
  expect(r.json.state).toBe('approved')
}
const until = async (request: APIRequestContext, who: typeof dana, id: string, state: string) =>
  expect.poll(async () => (await card(request, who, id)).state, { timeout: 45_000, intervals: [500] }).toBe(state)

test.beforeAll(async ({ request }) => {
  danaId = (await me(request, dana)).memberId
  adminId = (await me(request, admin)).memberId
  for (const op of OPS) await ceiling(request, op, false)
  // The hub's Shopify account answers a read, so it has a connect date the first request copies into D1 (M2-D).
  expect((await hubCall(request, 'callTool', 'orders_search', { first: 1 })).ok).toBe(true)
})

test.afterAll(async ({ request }) => {
  for (const op of OPS) await ceiling(request, op, false)
})

test('off, every request is refused over_ceiling and nothing reaches the store', async ({ request }) => {
  for (const [op, args] of [[RESTOCK, { inventoryItemId: ITEM, locationId: LOCATION, quantity: 1 }], [REDUCE, { inventoryItemId: ITEM, locationId: LOCATION, quantity: 1, reason: 'damaged' }], [REFUND, refundArgs()]] as const) {
    expect(await requestAction(request, adminId, op, args)).toMatchObject({ outcome: 'refused', reason: 'over_ceiling' })
    expect(await storeWrites(request, op)).toEqual([])
  }
})

test('the hub\'s currency is copied into D1 with the write store', async ({ request }) => {
  await ceiling(request, RESTOCK, true)
  await requestAction(request, danaId, RESTOCK, { inventoryItemId: ITEM, locationId: LOCATION, quantity: 1 })
  expect(readSql('SELECT shop, currency FROM connector_accounts WHERE account_id = ?', SHOPIFY_ACCOUNT)).toEqual([{ shop: 'example-write', currency: 'USD' }])
})

test('a restock is an ask card; allowed once, it goes out once with the action\'s idempotency key', async ({ request }) => {
  test.setTimeout(90_000)
  await ceiling(request, RESTOCK, true)
  const r = await requestAction(request, danaId, RESTOCK, { inventoryItemId: ITEM, locationId: LOCATION, quantity: 7 })
  expect(r).toMatchObject({ outcome: 'waiting', action: { verdict: 'ask', units: 7, records: 1 } })
  const id = r.action!.id as string
  const before = (await storeWrites(request, RESTOCK)).length
  await answer(request, dana, id, 'once')
  await until(request, dana, id, 'sent')
  const sent = (await storeWrites(request, RESTOCK)).slice(before)
  expect(sent).toEqual([{
    operation: RESTOCK,
    variables: {
      input: { name: 'available', reason: 'restock', changes: [{ inventoryItemId: ITEM, locationId: LOCATION, delta: 7, changeFromQuantity: null }] },
      idempotencyKey: `${id}:1`,
    },
    outcome: 'succeed',
  }])
  expect((await card(request, dana, id)).result).toBeTruthy()
})

test('a reduce is an exact destructive card, even for its asker; approved, it goes out once with a negative delta', async ({ request }) => {
  test.setTimeout(90_000)
  await ceiling(request, REDUCE, true)
  const r = await requestAction(request, danaId, REDUCE, { inventoryItemId: ITEM, locationId: LOCATION, quantity: 2, reason: 'damaged' })
  expect(r).toMatchObject({ outcome: 'waiting', action: { verdict: 'exact', guardrail: 'destructive', approver: danaId } })
  const id = r.action!.id as string
  const before = (await storeWrites(request, REDUCE)).length
  await answer(request, dana, id, 'approve')
  await until(request, dana, id, 'sent')
  const sent = (await storeWrites(request, REDUCE)).slice(before)
  expect(sent).toHaveLength(1)
  expect(sent[0]!.variables).toMatchObject({ input: { reason: 'damaged', changes: [{ delta: -2 }] }, idempotencyKey: `${id}:1` })
})

test('a member\'s refund is an admins card; another currency is invalid_args; past the largest call over_limit', async ({ request }) => {
  await ceiling(request, REFUND, true)
  // Stage 1 M3-X (N25): was refused `needs_admin`. Said No to at once, so nothing of it goes out.
  const asked = await requestAction(request, danaId, REFUND, refundArgs())
  expect(asked).toMatchObject({ outcome: 'waiting', action: { verdict: 'exact', guardrail: 'money', approver_kind: 'admins', approver: 'role:admin' } })
  const no = await call(request, admin, 'POST', `/api/actions/${asked.action!.id}/answer`, { json: { choice: 'deny', ifRev: asked.action!.rev } })
  expect(no.status, no.text).toBe(200)
  expect(await requestAction(request, adminId, REFUND, refundArgs({ amount: { minor: 500, currency: 'EUR' } }))).toMatchObject({ outcome: 'refused', reason: 'invalid_args' })
  expect(await requestAction(request, adminId, REFUND, refundArgs({ amount: { minor: 50_001, currency: 'USD' } }))).toMatchObject({ outcome: 'refused', reason: 'over_limit' })
  expect(await storeWrites(request, REFUND)).toEqual([])
})

test('an admin\'s refund is an exact money card; approved, it goes out once for exactly the approved amount', async ({ request }) => {
  test.setTimeout(90_000)
  await ceiling(request, REFUND, true)
  const r = await requestAction(request, adminId, REFUND, refundArgs())
  expect(r).toMatchObject({ outcome: 'waiting', action: { verdict: 'exact', guardrail: 'money', approver: adminId, units: 500 } })
  const id = r.action!.id as string
  await answer(request, admin, id, 'approve')
  await until(request, admin, id, 'sent')
  const sent = await storeWrites(request, REFUND)
  expect(sent).toHaveLength(1)
  expect(sent[0]!.variables).toEqual({
    input: {
      orderId: 'gid://shopify/Order/9001', currency: 'USD', notify: false,
      refundLineItems: [{ lineItemId: 'gid://shopify/LineItem/90012', quantity: 1, restockType: 'NO_RESTOCK' }],
      transactions: [{ orderId: 'gid://shopify/Order/9001', parentId: 'gid://shopify/OrderTransaction/70001', gateway: 'bogus', kind: 'REFUND', amount: '5.00' }],
    },
    idempotencyKey: `${id}:1`,
  })
  expect((await card(request, admin, id)).result).toContain('5.00 USD')
})
