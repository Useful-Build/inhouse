// Stage 1 M3-W (N23, N24, N32's second line): limits and a revoke in a batch's hold through the real routes, on the local
// test build (CI's `test-build`, no container). A write is made by the test-fakes hook's `action` op (the egress's own
// `actions` handler with a made-up run grant and a stand-in admission, everything after it the real path); answers go
// through route 122, permissions through their own routes; BrandAgent's own alarm sends through `HUB_WRITE` into the
// hub's fake Shopify write store, whose log the hook's `state` reads. Oracles, the plan's words written out here:
//  - the largest single call (N23): a call past the ceiling's is refused `over_limit` whatever approves it; a call past
//    the permission's (but within the ceiling's) is never run under it: it waits on one exact `count` card;
//  - a ceiling lowered while a card waits refuses its answer (409 `over_limit`) and approves nothing;
//  - N32: a batch run under a permission (4 orders, within its largest call of 5 and the bulk threshold of 5) whose
//    permission is removed during its 10 s hold sends nothing, and its units go back.
// The other N32 hold proofs: the single action (actions.spec.ts), an admin's refund approval demoted during its hold
// (admin-cards.spec.ts), and a batch stopped between items 10 and 11 (the write-safety gate's fixed example, in
// server/outbox/write-safety.property.test.ts, where the stop lands exactly there). The ceiling rows are set only through
// the hook and turned off again after (and before, in case a killed run left them on); the permissions made are removed.
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { createChat } from './chat-kit.ts'
import { readSql } from './db.ts'
import { hook, hubCall } from './fakes-kit.ts'
import { actor, call, me } from './kit.ts'

const dana = actor('memberA')
test.describe.configure({ mode: 'serial' })

const TAG_ADD = 'shopify.order.tag_add'
const RESTOCK = 'shopify.inventory.restock'
const run = Date.now().toString(36)

/** A restock of the fake store's item 8001 at location 601 (test/upstreams/shopify/write: it stocks that pair). */
const restock = (quantity: number) => ({ inventoryItemId: 'gid://shopify/InventoryItem/8001', locationId: 'gid://shopify/Location/601', quantity, reason: 'restock' })

interface Card {
  id: string; rev: number; state: string; kind: string; guardrail?: string
  batch?: { itemCount: number; totals: { records: number; units: number } }
}
let danaId = ''

const ceiling = async (request: APIRequestContext, operation: string, enabled: boolean, limits: { perDayMax?: number; unitsMax?: number; bulkThreshold?: number } = {}) => {
  const r = await hook(request, { op: 'ceiling', operation, enabled, perDayMax: limits.perDayMax ?? 200, unitsMax: limits.unitsMax ?? 100, bulkThreshold: limits.bulkThreshold ?? 5, batchMax: 500 })
  expect(r.status, r.text).toBe(200)
}
const ask = async (request: APIRequestContext, chatId: string, operation: string, args: Record<string, unknown>) => {
  const r = await hook(request, { op: 'action', as: { memberId: danaId, chatId }, operation, args })
  expect(r.status, r.text).toBe(200)
  return r.json.result as { outcome: string; reason?: string; text?: string; action: { id: string; rev: number; kind: string; state: string; items_n: number; verdict: string; guardrail: string | null } }
}
const card = async (request: APIRequestContext, id: string): Promise<Card> => {
  const r = await call(request, dana, 'GET', `/api/actions/${id}`)
  expect(r.status, r.text).toBe(200)
  return r.json as Card
}
const permissionFor = async (request: APIRequestContext, operation: string) =>
  ((await call(request, dana, 'GET', '/api/permissions')).json.items as { id: string; rev: number; operation: string; limits: { perDay: number; unitsMax: number }; can: { remove: boolean } }[])
    .find(p => p.operation === operation)
const removePermissions = async (request: APIRequestContext) => {
  for (const operation of [TAG_ADD, RESTOCK]) {
    for (let p = await permissionFor(request, operation); p?.can.remove; p = await permissionFor(request, operation)) {
      const r = await call(request, dana, 'POST', `/api/permissions/${p.id}/remove`, { json: { ifRev: p.rev } })
      expect(r.status, r.text).toBe(200)
    }
  }
}
/** "Always allow" on a first card makes the member's permission (the operation's defaults); that card is undone in its hold. */
const allowAlways = async (request: APIRequestContext, chatId: string, operation: string, args: Record<string, unknown>) => {
  const first = await ask(request, chatId, operation, args)
  expect(first.outcome, JSON.stringify(first)).toBe('waiting')
  const always = await call(request, dana, 'POST', `/api/actions/${first.action.id}/answer`, { json: { choice: 'always', ifRev: first.action.rev } })
  expect(always.status, always.text).toBe(200)
  const undone = await call(request, dana, 'POST', `/api/actions/${first.action.id}/undo`, { json: { ifRev: always.json.rev } })
  expect(undone.status, undone.text).toBe(200)
  return (await permissionFor(request, operation))!
}
const writesTagged = async (request: APIRequestContext, tag: string): Promise<number> => {
  const r = await hook(request, { op: 'state' })
  expect(r.status, r.text).toBe(200)
  return (r.json.shopifyWrite as { writes: { variables: { tags?: string[] } }[] }).writes.filter(w => w.variables.tags?.includes(tag)).length
}

test.beforeAll(async ({ request }) => {
  danaId = (await me(request, dana)).memberId
  await ceiling(request, TAG_ADD, false)
  await ceiling(request, RESTOCK, false)
  await removePermissions(request)
  // The hub's Shopify account answers a read, so the write path can use it (and copies its generation into D1).
  expect((await hubCall(request, 'callTool', 'orders_search', { first: 1 })).ok).toBe(true)
  const set = await hook(request, { op: 'set', shopifyWrite: { faults: { [TAG_ADD]: 'succeed' } } })
  expect(set.status, set.text).toBe(200)
})

test.afterAll(async ({ request }) => {
  await ceiling(request, TAG_ADD, false)
  await ceiling(request, RESTOCK, false)
  await removePermissions(request)
})

test('the largest single call: past the ceiling\'s is refused, past the permission\'s waits on one exact card', async ({ request }) => {
  await ceiling(request, RESTOCK, true, { perDayMax: 1000, unitsMax: 500 })
  const chatId = await createChat(request, dana)
  // Past the ceiling's largest call: refused, nothing written, whatever a person or a permission would say.
  const over = await ask(request, chatId, RESTOCK, restock(600))
  expect(over).toMatchObject({ outcome: 'refused', reason: 'over_limit' })
  const perm = await allowAlways(request, chatId, RESTOCK, restock(5))
  expect(perm.limits).toMatchObject({ perDay: 200, unitsMax: 50 })
  // Within the permission's largest call: run under it.
  const within = await ask(request, chatId, RESTOCK, restock(20))
  expect(within.outcome, JSON.stringify(within)).toBe('approved')
  const undone = await call(request, dana, 'POST', `/api/actions/${within.action.id}/undo`, { json: { ifRev: within.action.rev } })
  expect(undone.status, undone.text).toBe(200)
  // Past it (but within the ceiling's): never run, one exact `count` card holding the call.
  const past = await ask(request, chatId, RESTOCK, restock(60))
  expect(past.outcome, JSON.stringify(past)).toBe('collected')
  const c = await card(request, past.action.id)
  expect(c).toMatchObject({ kind: 'exact', state: 'waiting', batch: { itemCount: 1, totals: { records: 1, units: 60 } } })

  // The ceiling lowered while the card waits: its answer is refused and approves nothing.
  await ceiling(request, RESTOCK, true, { perDayMax: 1000, unitsMax: 50 })
  const refused = await call(request, dana, 'POST', `/api/actions/${c.id}/answer`, { json: { choice: 'approve', ifRev: c.rev, upTo: 1, totals: { records: 1, units: 60 } } })
  expect(refused.status, refused.text).toBe(409)
  expect(refused.json.error).toMatchObject({ code: 'conflict', reason: 'over_limit' })
  expect((await card(request, c.id)).state).toBe('waiting')
  const no = await call(request, dana, 'POST', `/api/actions/${c.id}/answer`, { json: { choice: 'deny', ifRev: c.rev, upTo: 1, totals: { records: 1, units: 60 } } })
  expect(no.status, no.text).toBe(200)
  await ceiling(request, RESTOCK, false)
})

test('N32: a batch run under a permission, removed during its 10 s hold, sends nothing and gives its units back', async ({ request }) => {
  test.setTimeout(90_000)
  await ceiling(request, TAG_ADD, true, { perDayMax: 200, unitsMax: 100, bulkThreshold: 5 })
  const chatId = await createChat(request, dana)
  const perm = await allowAlways(request, chatId, TAG_ADD, { orderIds: ['gid://shopify/Order/9001'], tags: [`allow-${run}`] })
  expect(perm.limits).toMatchObject({ perDay: 50, unitsMax: 5 })
  const tag = `hold-${run}`
  const orders = ['9001', '9002', '9003', '9004'].map(n => `gid://shopify/Order/${n}`)
  const b = await ask(request, chatId, TAG_ADD, { orderIds: orders, tags: [tag] })
  expect(b, JSON.stringify(b)).toMatchObject({ outcome: 'approved', action: { kind: 'batch', items_n: 4, verdict: 'run', state: 'approved' } })
  // The permission goes inside the hold.
  const removed = await call(request, dana, 'POST', `/api/permissions/${perm.id}/remove`, { json: { ifRev: perm.rev } })
  expect(removed.status, removed.text).toBe(200)
  // Past the hold, the claim is refused: the batch lapses back to waiting for a person's OK, and nothing went out.
  await expect.poll(async () => (await card(request, b.action.id)).state, { timeout: 45_000, intervals: [500] }).toBe('waiting')
  expect(await writesTagged(request, tag)).toBe(0)
  expect(readSql('SELECT released_at_ms IS NOT NULL AS released FROM permission_uses WHERE id = ?', `${b.action.id}#1`)).toEqual([{ released: 1 }])
  const after = await card(request, b.action.id)
  const no = await call(request, dana, 'POST', `/api/actions/${b.action.id}/answer`, { json: { choice: 'deny', ifRev: after.rev, upTo: 4, totals: { records: 4, units: 4 } } })
  expect(no.status, no.text).toBe(200)
  expect(await writesTagged(request, tag)).toBe(0)
  await ceiling(request, TAG_ADD, false)
})
