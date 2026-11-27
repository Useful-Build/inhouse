// Stage 1 M3-B (N22, N32): batches through the real routes, on the local test build (CI's `test-build`, no container). A
// write is made by the test-fakes hook's `action` op (the egress's own `actions` handler with a made-up run grant and a
// stand-in admission, everything after it the real path); answers go through route 122, the full list through route
// 125; BrandAgent's own alarm runs each batch's passes through `HUB_WRITE` into the hub's fake Shopify write store, and
// the effects are read from that store's log (the hook's `state`). Oracles, the plan's words written out here (N32's
// first line, with N24's limits):
//  - ceiling for tag_add on, per day max 200, largest call 100, bulk threshold 5, batch max 500; one permission held by
//    the member, per day 50, largest call 5 (the operation's defaults, made by "Always allow");
//  - 500 calls of one order each in one chat: 50 run under the permission (each within every limit) and go out after
//    their holds; calls 51 to 500 join one collecting batch with 450 items; no other card; the store holds 50 writes;
//  - approved with `upTo = 200` and the totals the card showed: 200 more writes, and the 250 left sit on a new
//    collecting card; the full list pages 100 at a time.
// The ceiling is set only through the hook and turned off again after (and before, in case a killed run left it on).
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { createChat } from './chat-kit.ts'
import { readSql } from './db.ts'
import { hook, hubCall, requestAction, setCeiling } from './fakes-kit.ts'
import { actor, call, me } from './kit.ts'

const dana = actor('memberA')
test.describe.configure({ mode: 'serial' })

const TAG_ADD = 'shopify.order.tag_add'
const run = Date.now().toString(36)
const LOOP_TAG = `m3b-${run}`
const orderArgs = (order: number, tag = LOOP_TAG) => ({ orderIds: [`gid://shopify/Order/${order}`], tags: [tag] })

interface StoreWrite { operation: string; variables: { tags?: string[] } }
const loopWrites = async (request: APIRequestContext): Promise<number> => {
  const r = await hook(request, { op: 'state' })
  expect(r.status, r.text).toBe(200)
  return (r.json.shopifyWrite as { writes: StoreWrite[] }).writes.filter(w => w.variables.tags?.includes(LOOP_TAG)).length
}

interface BatchCard {
  id: string; rev: number; state: string; kind: string; result?: string
  batch?: { itemCount: number; firstLines: string[]; totals: { records: number; units: number; unitsLabel: string } }
}
const card = async (request: APIRequestContext, id: string): Promise<BatchCard> => {
  const r = await call(request, dana, 'GET', `/api/actions/${id}`)
  expect(r.status, r.text).toBe(200)
  return r.json as BatchCard
}

let danaId = ''

test.beforeAll(async ({ request }) => {
  danaId = (await me(request, dana)).memberId
  if (readSql('SELECT 1 FROM permission_ceiling WHERE enabled = 1').length > 0) await setCeiling(request, TAG_ADD, false)
  // The hub's Shopify account answers a read, so the write path can use it (and copies its generation into D1).
  expect((await hubCall(request, 'callTool', 'orders_search', { first: 1 })).ok).toBe(true)
  const set = await hook(request, { op: 'set', shopifyWrite: { faults: { [TAG_ADD]: 'succeed' } } })
  expect(set.status, set.text).toBe(200)
  const r = await hook(request, { op: 'ceiling', operation: TAG_ADD, enabled: true, perDayMax: 200, unitsMax: 100, bulkThreshold: 5, batchMax: 500 })
  expect(r.status, r.text).toBe(200)
})

test.afterAll(async ({ request }) => {
  await setCeiling(request, TAG_ADD, false)
  // The permission this spec made goes, so no later spec finds one.
  const perms = await call(request, dana, 'GET', '/api/permissions')
  for (const p of (perms.json.items ?? []) as { id: string; rev: number; operation: string; can: { remove: boolean } }[]) {
    if (p.operation === TAG_ADD && p.can.remove) await call(request, dana, 'POST', `/api/permissions/${p.id}/remove`, { json: { ifRev: p.rev } })
  }
})

test('a loop of 500 allowed writes stops at the limit and becomes one card; approving 200 sends 200, the rest wait', async ({ request }) => {
  test.setTimeout(600_000)
  const chatId = await createChat(request, dana)

  // "Always allow" on a first card makes the permission (per day 50, largest call 5); that card is undone in its hold, so
  // its unit goes back and the loop has the whole day.
  const first = await requestAction(request, { memberId: danaId, chatId }, TAG_ADD, orderArgs(1, `${LOOP_TAG}-first`))
  expect(first.outcome, JSON.stringify(first)).toBe('waiting')
  const always = await call(request, dana, 'POST', `/api/actions/${first.action.id}/answer`, { json: { choice: 'always', ifRev: first.action.rev } })
  expect(always.status, always.text).toBe(200)
  expect(always.json).toMatchObject({ state: 'approved', permissionId: expect.any(String) })
  const undone = await call(request, dana, 'POST', `/api/actions/${first.action.id}/undo`, { json: { ifRev: always.json.rev } })
  expect(undone.status, undone.text).toBe(200)
  const perm = (await call(request, dana, 'GET', '/api/permissions')).json.items.find((p: { operation: string }) => p.operation === TAG_ADD)
  expect(perm).toMatchObject({ limits: { perDay: 50, unitsMax: 5 } })

  const outcomes: string[] = []
  let batchId = ''
  for (let k = 1; k <= 500; k++) {
    const r = await requestAction(request, { memberId: danaId, chatId }, TAG_ADD, orderArgs(1000 + k))
    outcomes.push(r.outcome)
    if (r.outcome === 'collected') {
      batchId ||= r.action.id
      expect(r.action.id, `call ${k} joined the one batch`).toBe(batchId)
      expect(r.item.n).toBe(k - 50)
    }
  }
  expect(outcomes.slice(0, 50)).toEqual(Array(50).fill('approved'))
  expect(outcomes.slice(50)).toEqual(Array(450).fill('collected'))

  const batch = await card(request, batchId)
  expect(batch).toMatchObject({ kind: 'exact', state: 'waiting', batch: { itemCount: 450, totals: { records: 450, units: 450, unitsLabel: 'orders' } } })
  expect(batch.batch!.firstLines).toHaveLength(10)
  // No other card: the chat's waiting cards are the batch alone.
  const waiting = await call(request, dana, 'GET', `/api/actions?states=waiting&chatId=${chatId}`)
  expect((waiting.json.items as { id: string }[]).map(c => c.id)).toEqual([batchId])

  // The 50 runs go out after their holds; nothing else does.
  await expect.poll(() => loopWrites(request), { timeout: 120_000, intervals: [1_000] }).toBe(50)

  // The full list pages 100 at a time.
  const page1 = await call(request, dana, 'GET', `/api/actions/${batchId}/items?after=0`)
  expect(page1.status, page1.text).toBe(200)
  expect(page1.json.items).toHaveLength(100)
  expect(page1.json.next).toBe(100)
  expect(page1.json.items[0]).toMatchObject({ n: 1, state: 'pending', line: expect.stringContaining('Order 1051') })

  // Approve what was seen, the first 200; the 250 after move to a new collecting card.
  const approved = await call(request, dana, 'POST', `/api/actions/${batchId}/answer`, {
    json: { choice: 'approve', ifRev: batch.rev, upTo: 200, totals: { records: 200, units: 200 } },
  })
  expect(approved.status, approved.text).toBe(200)
  expect(approved.json).toMatchObject({ state: 'approved', batch: { itemCount: 200 } })
  const after = await call(request, dana, 'GET', `/api/actions?states=waiting&chatId=${chatId}`)
  const rest = (after.json.items as BatchCard[])
  expect(rest).toHaveLength(1)
  expect(rest[0]).toMatchObject({ kind: 'exact', batch: { itemCount: 250, totals: { records: 250, units: 250 } } })
  expect(rest[0]!.id).not.toBe(batchId)

  await expect.poll(() => loopWrites(request), { timeout: 240_000, intervals: [2_000] }).toBe(250)
  await expect.poll(async () => (await card(request, batchId)).state, { timeout: 60_000, intervals: [1_000] }).toBe('sent')
  expect((await card(request, batchId)).result).toBe('Sent. 200 of 200 went out')
  // Nothing more went out: the rest wait for their own answer.
  expect(await loopWrites(request)).toBe(250)
  const no = await call(request, dana, 'POST', `/api/actions/${rest[0]!.id}/answer`, {
    json: { choice: 'deny', ifRev: rest[0]!.rev, upTo: 250, totals: { records: 250, units: 250 } },
  })
  expect(no.status, no.text).toBe(200)
  expect(no.json.state).toBe('denied')
})

test('a batch answer must name what it saw: stale totals are 409 `totals_changed`, a single card takes none', async ({ request }) => {
  const chatId = await createChat(request, dana)
  const tag = `${LOOP_TAG}-totals`
  const ids: string[] = []
  for (let k = 1; k <= 7; k++) ids.push((await requestAction(request, { memberId: danaId, chatId }, TAG_ADD, orderArgs(5000 + k, tag))).action.id)
  // The permission from the first test runs the first calls; make sure this chat has a collecting card.
  const cards = (await call(request, dana, 'GET', `/api/actions?chatId=${chatId}`)).json.items as BatchCard[]
  const b = cards.find(c => c.batch !== undefined && c.state === 'waiting')
  expect(b, 'a collecting card').toBeDefined()
  const stale = await call(request, dana, 'POST', `/api/actions/${b!.id}/answer`, {
    json: { choice: 'approve', ifRev: b!.rev, upTo: b!.batch!.itemCount, totals: { records: b!.batch!.totals.records + 1, units: b!.batch!.totals.units } },
  })
  expect(stale.status, stale.text).toBe(409)
  expect(stale.json.error).toMatchObject({ code: 'conflict', reason: 'totals_changed' })
  const bare = await call(request, dana, 'POST', `/api/actions/${b!.id}/answer`, { json: { choice: 'approve', ifRev: b!.rev } })
  expect(bare.status, bare.text).toBe(400)
  const denied = await call(request, dana, 'POST', `/api/actions/${b!.id}/answer`, {
    json: { choice: 'deny', ifRev: b!.rev, upTo: b!.batch!.itemCount, totals: b!.batch!.totals },
  })
  expect(denied.status, denied.text).toBe(200)
  // A single action has no list.
  const single = cards.find(c => c.batch === undefined)
  if (single) expect((await call(request, dana, 'GET', `/api/actions/${single.id}/items`)).status).toBe(404)
})
