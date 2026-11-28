// Stage 1 M3-J: N32's lines from the screens, on the test build (CI's `test-build` job; no container). Each write is the
// agent's call through the egress's own `actions` handler (the test-fakes hook's `action` op, a made-up run grant and a
// stand-in admission; everything after it is the real path: the outbox's request, the limits, the batch, BrandAgent's
// alarm and the send into the hub's fake Shopify write store). The person answers on the screen. It would fail if:
//  - the loop of 500 allowed calls (ceiling: per day 200, largest call 100, bulk threshold 5, batch max 500; Dana's
//    permission: per day 50, largest call 5) didn't run exactly the first 50 under the permission and collect every
//    later call onto one card, with no other card;
//  - Approvals didn't show that one card, or its approval covered anything but what the screen showed: the card's list
//    is open when the last 3 calls arrive, and "Approve all 447" approves the 447 shown while the 3 wait on a new card;
//  - a Pause in the middle of that batch's send recalled what had gone out, sent anything after it, or left the rest
//    anywhere but a new card that needs a fresh OK (and says why); or that card, approved after Resume, didn't send them;
//  - a permission removed on Settings, Always allowed, during a batch's hold (4 orders run under it) let any of it out,
//    or the batch didn't come back as a card that needs a fresh OK.
// Counted from the outbox's own states (cards and their item lists), never from the fake store's log, so the spec reads
// the same on the sandbox deploy (#619). The agent's own loop through a real container is e2e/api/write-loop.spec.ts
// (sandbox, named only); the API twins are e2e/api/batches.spec.ts and limits.spec.ts; the exact stop between items 10
// and 11 is server/outbox/write-safety.property.test.ts. The ceiling is set only through the hook and turned off after.
import type { APIRequestContext, Page } from '@playwright/test'
import { expect, test } from '../support/test-build/index.js'
import { open, signInAs } from '../support/clients/real.js'
import type { Who } from '../support/clients/real.js'
import { actor, call, me } from '../api/kit.ts'
import type { Actor } from '../api/kit.ts'
import { createChat } from '../api/chat-kit.ts'
import { hook, hubCall, requestAction, setCeiling } from '../api/fakes-kit.ts'
import { SHOPIFY_READ } from '../support/test-build/shopify-read.ts'

const TAG_ADD = 'shopify.order.tag_add'
const dana = actor('memberA')
const leo = actor('memberB')
const admin = actor('admin')
const LOOP = 500
const SHOWN = 447
test.describe.configure({ mode: 'serial' })

const run = Date.now().toString(36)
/** Call `k`'s arguments: one of the fake store's orders (9001 to 9003) and a tag of its own, so no two share a payload. */
const callArgs = (prefix: string, k: number) => ({ orderIds: [`gid://shopify/Order/${9001 + (k % 3)}`], tags: [`${prefix}-${k}`] })

interface Card {
  id: string; rev: number; state: string; kind: string; result?: string; lapsed?: string
  batch?: { itemCount: number; totals: { records: number; units: number } }
}
const cardsAs = async (request: APIRequestContext, who: Actor, q: string): Promise<Card[]> => {
  const r = await call(request, who, 'GET', `/api/actions?${q}`)
  expect(r.status, r.text).toBe(200)
  return r.json.items as Card[]
}
const cardAs = async (request: APIRequestContext, who: Actor, id: string): Promise<Card> => {
  const r = await call(request, who, 'GET', `/api/actions/${id}`)
  expect(r.status, r.text).toBe(200)
  return r.json as Card
}
/** A batch's whole list through route 125 (100 a page). */
const itemsOf = async (request: APIRequestContext, who: Actor, id: string): Promise<{ n: number; state: string }[]> => {
  const out: { n: number; state: string }[] = []
  for (let after: number | undefined = 0; after !== undefined;) {
    const r = await call(request, who, 'GET', `/api/actions/${id}/items?after=${after}`)
    expect(r.status, r.text).toBe(200)
    out.push(...(r.json.items as { n: number; state: string }[]))
    after = r.json.next as number | undefined
  }
  return out
}

async function removeTagPermissions(request: APIRequestContext) {
  for (const p of (await call(request, admin, 'GET', '/api/permissions')).json.items as { id: string; rev: number; operation: string; can: { remove: boolean } }[]) {
    if (p.operation !== TAG_ADD || !p.can.remove) continue
    const r = await call(request, admin, 'POST', `/api/permissions/${p.id}/remove`, { json: { ifRev: p.rev } })
    expect([200, 404], r.text).toContain(r.status)
  }
}

/** "Always allow" on a first card, taken back in its hold: the permission (per day 50, largest call 5), its day unused. */
async function allowAlways(request: APIRequestContext, who: Actor, memberId: string, tag: string) {
  const chatId = await createChat(request, who)
  const first = await requestAction(request, { memberId, chatId }, TAG_ADD, { orderIds: ['gid://shopify/Order/9001'], tags: [tag] })
  expect(first.outcome, JSON.stringify(first)).toBe('waiting')
  const always = await call(request, who, 'POST', `/api/actions/${first.action.id}/answer`, { json: { choice: 'always', ifRev: first.action.rev } })
  expect(always.status, always.text).toBe(200)
  const undone = await call(request, who, 'POST', `/api/actions/${first.action.id}/undo`, { json: { ifRev: always.json.rev } })
  expect(undone.status, undone.text).toBe(200)
  const perm = ((await call(request, who, 'GET', '/api/permissions')).json.items as { operation: string; limits: unknown }[]).find(p => p.operation === TAG_ADD)
  expect(perm).toMatchObject({ limits: { perDay: 50, unitsMax: 5 } })
}

const toast = (page: Page, text: string) => page.locator('[data-toast]').filter({ hasText: text })
async function signedIn(page: Page, who: Who, hash: string) {
  await signInAs(page.context(), who)
  await open(page, who, hash)
}

let danaId = ''
let chatId = ''
let batchId = ''
let restId = ''
const LOOP_TAG = `m3j-${run}`

test.beforeEach(async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1440) < 600, 'server behaviour through the screens: the desktop project only (the batch card on a phone is batch-ui.spec.ts)')
})

test.beforeAll(async ({ request }) => {
  danaId = (await me(request, dana)).memberId
  expect((await hubCall(request, SHOPIFY_READ.method, SHOPIFY_READ.name, SHOPIFY_READ.args)).ok).toBe(true)
  expect((await call(request, admin, 'POST', '/api/resume', { json: {} })).status).toBe(200)
  await removeTagPermissions(request)
  const fault = await hook(request, { op: 'set', shopifyWrite: { faults: { [TAG_ADD]: 'succeed' } } })
  expect(fault.status, fault.text).toBe(200)
  const r = await hook(request, { op: 'ceiling', operation: TAG_ADD, enabled: true, perDayMax: 200, unitsMax: 100, bulkThreshold: 5, batchMax: 500 })
  expect(r.status, r.text).toBe(200)
})

test.afterAll(async ({ request }) => {
  expect((await call(request, admin, 'POST', '/api/resume', { json: {} })).status).toBe(200)
  // Every card this spec left waiting is answered No (a batch with the totals it holds), so no later spec finds one.
  for (const who of [dana, leo]) {
    for (const c of await cardsAs(request, who, 'states=waiting')) {
      const covers = c.batch ? { upTo: c.batch.itemCount, totals: { records: c.batch.totals.records, units: c.batch.totals.units } } : {}
      await call(request, who, 'POST', `/api/actions/${c.id}/answer`, { json: { choice: 'deny', ifRev: c.rev, ...covers } })
    }
  }
  await setCeiling(request, TAG_ADD, false)
  await removeTagPermissions(request)
})

test('the loop of 500 allowed writes stops at the limit and becomes one card; the approval covers what the screen showed', async ({ page, request }) => {
  // 500 hook calls: under a minute on CI's local test build, about 1 s each against the sandbox deploy.
  test.setTimeout(1_800_000)
  await allowAlways(request, dana, danaId, `first-${run}`)

  // The agent's loop: the first 50 run under the permission (one unit each, inside every limit); every call after them
  // is past its day and joins one collecting card. The last 3 come later, while the person reads the card.
  chatId = await createChat(request, dana)
  for (let k = 1; k <= LOOP - 3; k++) {
    const res = await requestAction(request, { memberId: danaId, chatId }, TAG_ADD, callArgs(LOOP_TAG, k))
    expect(res.outcome, `call ${k}: ${JSON.stringify(res)}`).toBe(k <= 50 ? 'approved' : 'collected')
    if (k > 50) {
      batchId ||= res.action.id
      expect(res.action.id, `call ${k} joins the one card`).toBe(batchId)
    }
  }
  const waiting = await cardsAs(request, dana, `states=waiting&chatId=${chatId}`)
  expect(waiting.map(c => [c.id, c.batch?.itemCount])).toEqual([[batchId, SHOWN]])

  // Approvals shows that one card; its full list is open when the last 3 calls arrive.
  await signedIn(page, 'dana', '#/approvals')
  const card = page.locator(`[data-action-id="${batchId}"]`)
  await expect(card.getByRole('heading', { name: `Add tags to ${SHOWN} orders` })).toBeVisible()
  await expect(card.locator('[data-card-actions] button')).toHaveText([`Approve all ${SHOWN}`, 'No'])
  await card.getByRole('button', { name: new RegExp(`^See all ${SHOWN}: `) }).click()
  const sheet = page.locator('[data-batch-sheet]')
  await expect(sheet).toBeVisible()
  for (let k = LOOP - 2; k <= LOOP; k++) {
    expect((await requestAction(request, { memberId: danaId, chatId }, TAG_ADD, callArgs(LOOP_TAG, k))).outcome).toBe('collected')
  }
  await expect(sheet.locator('[data-more-arrived]')).toHaveText('3 more arrived while you looked. They wait for their own OK.', { timeout: 15_000 })
  await sheet.getByRole('button', { name: `Approve all ${SHOWN}` }).click()
  await expect(toast(page, `Approved ${SHOWN}. They start going out in a few seconds.`)).toBeVisible()

  // The server holds exactly what was shown: 447 approved, and the 3 on a new card of their own that waits for an OK.
  expect(await cardAs(request, dana, batchId)).toMatchObject({ state: 'approved', batch: { itemCount: SHOWN, totals: { records: SHOWN, units: SHOWN } } })
  const rest = (await cardsAs(request, dana, `states=waiting&chatId=${chatId}`))
  expect(rest.map(c => c.batch?.itemCount)).toEqual([3])
  restId = rest[0]!.id
  expect(restId).not.toBe(batchId)
  expect((await itemsOf(request, dana, restId)).every(i => i.state === 'pending')).toBe(true)

  // The 50 run under the permission go out after their holds, each once: every call is accounted for.
  const singles = async () => (await cardsAs(request, dana, `chatId=${chatId}`)).filter(c => c.batch === undefined)
  await expect.poll(async () => (await singles()).filter(c => c.state === 'sent').length, { timeout: 300_000, intervals: [2_000] }).toBe(50)
  expect(await singles()).toHaveLength(50)
})

test('a Pause in the middle of the batch\'s send: what went out stays out, the rest moves to a new card that needs a fresh OK', async ({ page, request }) => {
  // On the sandbox deploy a pass of 20 items can take its full 10 s, so the ~400 moved items take minutes to send.
  test.setTimeout(900_000)
  // The batch sends in passes of 20 items, 1 s apart, so 447 items take over 20 s. Pause once the first have gone out.
  await expect.poll(async () => (await itemsOf(request, dana, batchId)).filter(i => i.state === 'sent').length,
    { timeout: 60_000, intervals: [250], message: 'the first items go out' }).toBeGreaterThan(0)
  const paused = await call(request, admin, 'POST', '/api/pause', { json: {} })
  expect(paused.status, paused.text).toBe(200)

  // The send stops at the next item: the batch ends with what went out, and every other item moves to a new card.
  await expect.poll(async () => (await cardAs(request, dana, batchId)).state, { timeout: 60_000, intervals: [500] }).toBe('sent')
  const done = await itemsOf(request, dana, batchId)
  const sent = done.length
  expect(done.every(i => i.state === 'sent'), JSON.stringify(done.filter(i => i.state !== 'sent'))).toBe(true)
  expect(sent).toBeLessThan(SHOWN)
  expect(await cardAs(request, dana, batchId)).toMatchObject({
    result: `Sent. ${sent} of ${SHOWN} went out; the other ${SHOWN - sent} moved to a new card for a new OK`, batch: { itemCount: sent },
  })
  const moved = (await cardsAs(request, dana, `states=waiting&chatId=${chatId}`)).filter(c => c.id !== restId)
  expect(moved.map(c => c.batch?.itemCount)).toEqual([SHOWN - sent])
  const movedId = moved[0]!.id
  expect(moved[0]!.lapsed).toBe('The agent was paused, so this needs your OK again.')
  expect((await itemsOf(request, dana, movedId)).every(i => i.state === 'pending')).toBe(true)

  // The new card on the screen says why and asks again; it can be answered only once the agent runs again.
  expect((await call(request, admin, 'POST', '/api/resume', { json: {} })).status).toBe(200)
  await signedIn(page, 'dana', '#/approvals')
  const card = page.locator(`[data-action-id="${movedId}"]`)
  await expect(card).toHaveAttribute('data-action-card', 'waiting')
  await expect(card).toContainText('The agent was paused, so this needs your OK again.')
  await card.getByRole('button', { name: `Approve all ${SHOWN - sent}` }).click()
  await expect(toast(page, `Approved ${SHOWN - sent}. They start going out in a few seconds.`)).toBeVisible()
  await expect.poll(async () => (await cardAs(request, dana, movedId)).state, { timeout: 600_000, intervals: [2_000] }).toBe('sent')
  expect((await itemsOf(request, dana, movedId)).every(i => i.state === 'sent')).toBe(true)
  // Nothing went out twice: the first batch's items are as they were, and the 3 that arrived late still wait.
  expect(await itemsOf(request, dana, batchId)).toEqual(done)
  expect((await itemsOf(request, dana, restId)).every(i => i.state === 'pending')).toBe(true)
})

test('a permission removed on Always allowed during a batch\'s hold: nothing goes out, and the batch comes back for a fresh OK', async ({ page, request }) => {
  test.setTimeout(120_000)
  // Leo's own permission (Dana's day is used up by the loop), and his Always allowed page open first, so the removal
  // lands well inside the batch's 10 s hold.
  const leoId = (await me(request, leo)).memberId
  await allowAlways(request, leo, leoId, `leo-first-${run}`)
  await signedIn(page, 'leo', '#/settings/you-permissions')
  const rows = page.locator('[data-permission]').filter({ hasText: 'Shopify' })
  await expect(rows).toHaveCount(1)

  const leoChat = await createChat(request, leo)
  // Four distinct orders (a repeated id is `invalid_args`); 9004 isn't in the fake store, which doesn't matter: nothing is sent.
  const orders = ['9001', '9002', '9003', '9004'].map(n => `gid://shopify/Order/${n}`)
  const b = await requestAction(request, { memberId: leoId, chatId: leoChat }, TAG_ADD, { orderIds: orders, tags: [`hold-${run}`] })
  expect(b, JSON.stringify(b)).toMatchObject({ outcome: 'approved', action: { kind: 'batch', items_n: 4, verdict: 'run', state: 'approved' } })
  await rows.first().getByRole('button', { name: /^Remove: / }).click()
  const ask = page.getByRole('dialog', { name: 'Stop allowing this?' }).or(page.getByRole('alertdialog', { name: 'Stop allowing this?' }))
  await ask.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(toast(page, 'Removed. Your Inhouse agent will ask first from now on.')).toBeVisible()
  const held = await call(request, leo, 'GET', `/api/actions/${b.action.id}`)
  expect(held.json.serverNow.ms, 'removed inside the hold').toBeLessThan(b.action.send_at_ms)

  // Past the hold the claim finds no live permission: the batch is a card again, every item still pending, and the
  // screen asks for a fresh OK with the reason.
  await expect.poll(async () => (await cardAs(request, leo, b.action.id)).state, { timeout: 45_000, intervals: [500] }).toBe('waiting')
  expect((await itemsOf(request, leo, b.action.id)).map(i => i.state)).toEqual(['pending', 'pending', 'pending', 'pending'])
  await open(page, 'leo', '#/approvals')
  const card = page.locator(`[data-action-id="${b.action.id}"]`)
  await expect(card).toContainText('The permission was removed, so this needs your OK again.')
  await expect(card.locator('[data-card-actions] button')).toHaveText(['Approve all 4', 'No'])
  await card.getByRole('button', { name: 'No', exact: true }).click()
  await expect.poll(async () => (await cardAs(request, leo, b.action.id)).state, { timeout: 15_000 }).toBe('denied')
  expect((await itemsOf(request, leo, b.action.id)).some(i => i.state === 'sent')).toBe(false)
})
