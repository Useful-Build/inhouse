// Stage 1 M2-J (M2 acceptance; N11, N12, N15, N19; P6 acceptance 1, 2, 3, 6, 9): M2's write path driven from the
// screens on the test build, each action seeded through the egress's own `actions` handler (the test-fakes hook's
// `action` op in `tool` mode: the outbox's `request`, the hub's accounts copied into D1, BrandAgent's send task) and every
// answer, Undo, removal and resolve made by a person on Approvals or Settings. Effects are read from the hub's fake
// Shopify write store (the hook's `state`), each traced to its action by a tag no other request carries. It would fail if:
//  - Allow once sent before the hold ended, sent more than one tag, or the page's own clock could make it send (the
//    countdown is moved on with Playwright's page clock: it runs out on the page while the server still holds it);
//  - Undo in the hold, or a Pause in the hold followed by Resume, let anything out;
//  - Always allow didn't skip the next card (the next action asked again), or a permission removed during that action's
//    hold didn't stop it;
//  - an unclear send (the store hangs past every deadline) didn't come back as "Needs a check", was sent again by the
//    system, or the person couldn't settle it;
//  - another member could see the card, answer it or open the chat it belongs to.
// The server's 10 s hold runs on the server's clock (no test seam moves it): the specs wait for it with web-first
// assertions and polls, never a fixed sleep. Writes stay off in deployable builds: only the hook turns the operation on
// (N2), and it is turned off again after each case. The phone layout of the same cards is real/actions-ui.spec.ts's; these
// scenarios prove the server's behaviour through the screens, so they run on the desktop project only.
import type { APIRequestContext, Page } from '@playwright/test'
import { expect, test } from '../support/test-build/index.js'
import { open, signInAs } from '../support/clients/real.js'
import type { Who } from '../support/clients/real.js'
import { actor, call, me } from '../api/kit.ts'
import type { Actor } from '../api/kit.ts'
import { createChat } from '../api/chat-kit.ts'
import { hook, hubCall, release, requestAction, setCeiling } from '../api/fakes-kit.ts'
import { SHOPIFY_READ } from '../support/test-build/shopify-read.ts'

const OPERATION = 'shopify.order.tag_add'
/** One of the fake write store's orders (test/upstreams/shopify/write/server.ts). */
const ORDER = 'gid://shopify/Order/9002'
const TITLE = 'Add a tag to order 9002'
const dana = actor('memberA')
const leo = actor('memberB')
const admin = actor('admin')

const run = Date.now().toString(36)
let n = 0
/** A tag no other request carries: the store's log names it, so each effect is traced to its action. */
const newTag = () => `m2j-${run}-${++n}`

interface StoreWrite { operation: string; variables: { id?: string; tags?: string[] }; outcome: string }
async function writesOf(request: APIRequestContext, tag: string): Promise<StoreWrite[]> {
  const r = await hook(request, { op: 'state' })
  expect(r.status, r.text).toBe(200)
  return (r.json.shopifyWrite as { writes: StoreWrite[] }).writes.filter(w => w.variables.tags?.includes(tag))
}

/** The fake write store's answer to the next tag writes (the hook's `set` op, hub/testing/fakes.ts). */
async function storeFault(request: APIRequestContext, fault: 'succeed' | 'timeout') {
  const r = await hook(request, { op: 'set', shopifyWrite: { faults: { [OPERATION]: fault } } })
  expect(r.status, r.text).toBe(200)
}

interface Row { id: string; state: string; verdict: string; grant_id: string | null; send_at_ms: number | null }
/**
 * The agent's write call through the egress handler, for Dana (and her chat, when given). `waiting` makes a card;
 * `approved` is a send under a permission (no card to answer).
 */
async function propose(request: APIRequestContext, tag: string, expected: 'waiting' | 'approved', chatId?: string): Promise<Row> {
  const { memberId } = await me(request, dana)
  const r = await requestAction(request, { memberId, ...(chatId ? { chatId } : {}) }, OPERATION, { orderId: ORDER, tags: [tag] })
  expect(r?.outcome, JSON.stringify(r)).toBe(expected)
  return r.action as Row
}

interface Card { id: string; rev: number; state: string; lapsed?: string; sendAt?: { ms: number }; serverNow: { ms: number } }
async function cardAs(request: APIRequestContext, who: Actor, id: string): Promise<Card> {
  const r = await call(request, who, 'GET', `/api/actions/${id}`)
  expect(r.status, r.text).toBe(200)
  return r.json as Card
}
/** Polls the card on the server until it reaches `state` (the send runs on BrandAgent's alarm, after the hold). */
const serverState = (request: APIRequestContext, id: string, state: string) =>
  expect.poll(async () => (await cardAs(request, dana, id)).state, { timeout: 60_000, intervals: [500], message: `action ${id} reaches ${state}` }).toBe(state)

/**
 * Proves the hold of every action approved before now has passed and its task has run: a fresh action allowed once now
 * goes out, and it was approved after them, so its task came due after theirs.
 */
async function laterOneGoesOut(request: APIRequestContext): Promise<void> {
  const tag = newTag()
  const row = await propose(request, tag, 'waiting')
  const a = await call(request, dana, 'POST', `/api/actions/${row.id}/answer`, { json: { choice: 'once', ifRev: 1 } })
  expect(a.status, a.text).toBe(200)
  await serverState(request, row.id, 'sent')
  expect(await writesOf(request, tag)).toHaveLength(1)
}

/** No permission left behind (an admin sees and removes every one). */
async function removePermissions(request: APIRequestContext) {
  const list = await call(request, admin, 'GET', '/api/permissions')
  expect(list.status, list.text).toBe(200)
  for (const p of list.json.items as { id: string; rev: number; can: { remove: boolean } }[]) {
    if (!p.can.remove) continue
    const r = await call(request, admin, 'POST', `/api/permissions/${p.id}/remove`, { json: { ifRev: p.rev } })
    expect([200, 404], r.text).toContain(r.status)
  }
}

const cardOf = (page: Page, tag: string) => page.locator('[data-action-card]').filter({ hasText: `Tag: ${tag}` })
const answers = (card: ReturnType<typeof cardOf>) => card.locator('[data-card-actions] button')
/**
 * An ask card's three answers, in any order: the server may put Always allow first (`nudgeAlways`, once the person has
 * allowed this kind of action before), so the order isn't the scenario's to fix.
 */
const expectAskAnswers = (card: ReturnType<typeof cardOf>) =>
  expect.poll(async () => (await answers(card).allTextContents()).sort(), { message: 'the card offers Allow once, Always allow and No' })
    .toEqual(['Allow once', 'Always allow', 'No'])
const toast = (page: Page, text: string) => page.locator('[data-toast]').filter({ hasText: text })

async function signedIn(page: Page, who: Who, hash: string) {
  await signInAs(page.context(), who)
  await open(page, who, hash)
}

test.beforeEach(async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 1440) < 600, 'server behaviour through the screens: the desktop project only (the phone layout is actions-ui.spec.ts)')
})

// The hub's Shopify account answers a read first: its client-credentials grant gives it the connect date M2-D's sync
// copies into D1 on the first request (N9: an action's generation). A killed run may have left the operation on.
test.beforeAll(async ({ request }) => {
  expect((await hubCall(request, SHOPIFY_READ.method, SHOPIFY_READ.name, SHOPIFY_READ.args)).ok).toBe(true)
})
test.beforeEach(async ({ request }) => {
  await removePermissions(request)
  await storeFault(request, 'succeed')
  await setCeiling(request, OPERATION, true)
})
// The test build's server is shared: the operation off again, the store answering normally, no permission and no pause
// left behind.
test.afterEach(async ({ request }) => {
  await setCeiling(request, OPERATION, false)
  await storeFault(request, 'succeed')
  await removePermissions(request)
  const resumed = await call(request, admin, 'POST', '/api/resume', { json: {} })
  expect(resumed.status, resumed.text).toBe(200)
})

test('Allow once: the countdown runs out on the page clock while nothing goes out; the server sends one tag after its hold', async ({ page, request }) => {
  test.setTimeout(120_000)
  const tag = newTag()
  const row = await propose(request, tag, 'waiting')
  // The page's clock is Playwright's: it flows as usual, and the test moves it on past the hold.
  await page.clock.install()
  await signedIn(page, 'dana', '#/approvals')
  const card = cardOf(page, tag)
  await expectAskAnswers(card)
  await card.getByRole('button', { name: 'Allow once' }).click()
  await expect(toast(page, 'Allowed once. It goes out in a few seconds.')).toBeVisible()
  await expect(card.getByRole('timer')).toHaveText(/^Goes out in (10|9|8) seconds$/)

  // The page's clock jumps 30 s: its countdown says it's going out. The server's hold hasn't ended, so the card on the
  // server is still approved and nothing has reached the store. No browser timer decides a send.
  await page.clock.runFor(30_000)
  await expect(card.getByRole('timer')).toHaveText('Going out now')
  const held = await cardAs(request, dana, row.id)
  expect(held.serverNow.ms, 'checked inside the server\'s hold').toBeLessThan(held.sendAt!.ms)
  expect(held.state).toBe('approved')
  expect(await writesOf(request, tag)).toEqual([])

  // The server's hold ends; the send runs on its alarm; the card reads itself until it settles.
  await expect(card).toHaveAttribute('data-action-card', 'sent', { timeout: 60_000 })
  await expect(card).toContainText('Done')
  await expect(answers(card)).toHaveCount(0)
  const sent = await cardAs(request, dana, row.id)
  expect(sent.serverNow.ms).toBeGreaterThanOrEqual(held.sendAt!.ms)
  expect(await writesOf(request, tag)).toEqual([{ operation: OPERATION, variables: { id: ORDER, tags: [tag] }, outcome: 'succeed' }])
  // Undo after the send is a conflict with the card as it is; still one write.
  const undo = await call(request, dana, 'POST', `/api/actions/${row.id}/undo`, { json: { ifRev: sent.rev } })
  expect(undo.status, undo.text).toBe(409)
  expect(await writesOf(request, tag)).toHaveLength(1)
})

test('Undo in the hold: nothing goes out, even after the hold has passed', async ({ page, request }) => {
  test.setTimeout(120_000)
  const tag = newTag()
  const row = await propose(request, tag, 'waiting')
  await signedIn(page, 'dana', '#/approvals')
  const card = cardOf(page, tag)
  await card.getByRole('button', { name: 'Allow once' }).click()
  await expect(card.getByRole('timer')).toBeVisible()
  await card.getByRole('button', { name: `Undo: ${TITLE}` }).click()
  await expect(card).toContainText('You took it back. Nothing went out.')
  await expect(answers(card)).toHaveCount(0)
  expect((await cardAs(request, dana, row.id)).state).toBe('undone')
  // Past the undone action's hold: a later one goes out, and the undone one sent nothing.
  await laterOneGoesOut(request)
  expect(await writesOf(request, tag)).toEqual([])
  expect((await cardAs(request, dana, row.id)).state).toBe('undone')
  await page.reload()
  await expect(cardOf(page, tag)).toHaveCount(0)
})

test('Always allow skips the next card: the next action is approved with no question, held, and sent once', async ({ page, request }) => {
  test.setTimeout(120_000)
  const firstTag = newTag()
  await propose(request, firstTag, 'waiting')
  await signedIn(page, 'dana', '#/approvals')
  const first = cardOf(page, firstTag)
  await first.getByRole('button', { name: 'Always allow' }).click()
  await expect(toast(page, "Allowed. Your Inhouse agent won't ask next time.")).toBeVisible()
  // Taken back in its hold: the permission stays, and this one sends nothing.
  await first.getByRole('button', { name: `Undo: ${TITLE}` }).click()
  await expect(first).toContainText('Always allow stays on. Remove it in Settings, Always allowed.')

  // The next one runs under the permission: approved at once, no card to answer, and it still waits out the hold.
  const nextTag = newTag()
  const next = await propose(request, nextTag, 'approved')
  expect(next).toMatchObject({ verdict: 'run', state: 'approved' })
  expect(next.grant_id).toMatch(/^pg_/)
  await page.reload()
  const card = cardOf(page, nextTag)
  await expect(card).toHaveAttribute('data-action-card', /^(approved|sending|sent)$/)
  await expect(card.getByRole('button', { name: /^(Allow once|Always allow|No)$/ })).toHaveCount(0)
  await expect(card).toHaveAttribute('data-action-card', 'sent', { timeout: 60_000 })
  expect(await writesOf(request, nextTag)).toEqual([expect.objectContaining({ outcome: 'succeed' })])
  expect(await writesOf(request, firstTag)).toEqual([])
})

test('a permission removed during the hold stops the send: the card asks again and nothing goes out', async ({ page, request }) => {
  test.setTimeout(120_000)
  // A permission, made from a card and that card taken back (so nothing of it goes out).
  const firstTag = newTag()
  await propose(request, firstTag, 'waiting')
  await signedIn(page, 'dana', '#/approvals')
  const first = cardOf(page, firstTag)
  await first.getByRole('button', { name: 'Always allow' }).click()
  await first.getByRole('button', { name: `Undo: ${TITLE}` }).click()
  await expect(first).toContainText('You took it back. Nothing went out.')

  // The Always allowed page is open first, so the removal lands well inside the next action's 10 s hold.
  await open(page, 'dana', '#/settings/you-permissions')
  const rows = page.locator('[data-permission]').filter({ hasText: 'Shopify' })
  await expect(rows).toHaveCount(1)
  const tag = newTag()
  const row = await propose(request, tag, 'approved')
  await rows.first().getByRole('button', { name: /^Remove: / }).click()
  const ask = page.getByRole('dialog', { name: 'Stop allowing this?' }).or(page.getByRole('alertdialog', { name: 'Stop allowing this?' }))
  await ask.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(toast(page, 'Removed. Your Inhouse agent will ask first from now on.')).toBeVisible()
  expect(row.send_at_ms, 'approved with a hold').not.toBeNull()
  expect((await cardAs(request, dana, row.id)).serverNow.ms, 'removed inside the hold').toBeLessThan(row.send_at_ms!)

  // The claim finds no live permission: the card goes back to waiting and says why. Nothing reached the store.
  await open(page, 'dana', '#/approvals')
  const card = cardOf(page, tag)
  await expect(card).toHaveAttribute('data-action-card', 'waiting', { timeout: 60_000 })
  await expect(card).toContainText('The permission was removed, so this needs your OK again.')
  await expectAskAnswers(card)
  expect(await writesOf(request, tag)).toEqual([])
  // Cleaned up: Dana says no.
  await card.getByRole('button', { name: 'No', exact: true }).click()
  await expect(card).toContainText('You said no. Nothing went out.')
})

test('Pause during the hold returns the card to waiting; nothing can be allowed while paused; Resume sends nothing', async ({ page, request }) => {
  test.setTimeout(150_000)
  const tag = newTag()
  const row = await propose(request, tag, 'waiting')
  await signedIn(page, 'dana', '#/approvals')
  const card = cardOf(page, tag)
  await card.getByRole('button', { name: 'Allow once' }).click()
  await expect(card.getByRole('timer')).toBeVisible()
  const approved = await cardAs(request, dana, row.id)
  expect(approved.state).toBe('approved')
  // The admin pauses the agent through the real route while the card is in its hold.
  const paused = await call(request, admin, 'POST', '/api/pause', { json: {} })
  expect(paused.status, paused.text).toBe(200)
  expect((await cardAs(request, dana, row.id)).serverNow.ms, 'paused inside the hold').toBeLessThan(approved.sendAt!.ms)

  // Back to waiting, with the reason, on the person's screen.
  await expect(card).toHaveAttribute('data-action-card', 'waiting', { timeout: 60_000 })
  await expect(card).toContainText('The agent was paused, so this needs your OK again.')
  // Allowing it again while paused is refused, and the card says so.
  await card.getByRole('button', { name: 'Allow once' }).click()
  await expect(card.getByRole('alert')).toBeVisible()
  await expect(card).toHaveAttribute('data-action-card', 'waiting')

  const resumed = await call(request, admin, 'POST', '/api/resume', { json: {} })
  expect(resumed.status, resumed.text).toBe(200)
  // Resuming sends nothing: past the hold a later action goes out, and this one is still waiting with nothing sent.
  await laterOneGoesOut(request)
  expect((await cardAs(request, dana, row.id)).state).toBe('waiting')
  expect(await writesOf(request, tag)).toEqual([])
  await page.reload()
  await expect(cardOf(page, tag)).toHaveAttribute('data-action-card', 'waiting')
  await cardOf(page, tag).getByRole('button', { name: 'No', exact: true }).click()
  await expect(cardOf(page, tag)).toContainText('You said no. Nothing went out.')
})

test('an unclear send needs a check: the system never sends it again, and the person settles it', async ({ page, request }) => {
  // The hold (10 s), the hub's 15 s limit and the card's own re-reads.
  test.setTimeout(150_000)
  const tag = newTag()
  const row = await propose(request, tag, 'waiting')
  // The store takes the write and never answers: the hub's deadline passes and it can't say whether it went out
  // (`sent: 'unknown'`), so the dispatcher records "Needs a check" (N11). The afterEach puts the store back.
  await storeFault(request, 'timeout')
  await signedIn(page, 'dana', '#/approvals')
  const card = cardOf(page, tag)
  await card.getByRole('button', { name: 'Allow once' }).click()
  await expect(card).toHaveAttribute('data-action-card', 'needs_check', { timeout: 90_000 })
  await expect(card).toContainText('Needs a check')
  await expect(answers(card)).toHaveText(['It went out', "It didn't go out"])
  await storeFault(request, 'succeed')
  expect(await writesOf(request, tag)).toEqual([expect.objectContaining({ outcome: 'timeout' })])

  // A scheduler pass now (the alarm's own body, route 67): nothing sends it again.
  const alarm = await call(request, release, 'POST', '/api/ops/alarm', { json: {} })
  expect(alarm.status, alarm.text).toBe(200)
  expect((await cardAs(request, dana, row.id)).state).toBe('needs_check')
  // Another member can't settle it (they can't see it).
  const c = await cardAs(request, dana, row.id)
  expect((await call(request, leo, 'POST', `/api/actions/${row.id}/resolve`, { json: { outcome: 'failed', ifRev: c.rev } })).status).toBe(404)

  // The person who allowed it settles it.
  await card.getByRole('button', { name: `It went out: ${TITLE}` }).click()
  await expect(card).toHaveAttribute('data-action-card', 'sent')
  await expect(answers(card)).toHaveCount(0)
  expect(await writesOf(request, tag)).toHaveLength(1)
  // Settled once: a second answer is a conflict.
  const again = await call(request, dana, 'POST', `/api/actions/${row.id}/resolve`, { json: { outcome: 'failed', ifRev: c.rev } })
  expect(again.status, again.text).toBe(409)
})

test("another member can't see the card, answer it or open the chat it belongs to", async ({ page, request }) => {
  const title = `M2-J chat ${run}`
  const chatId = await createChat(request, dana, undefined, title)
  const tag = newTag()
  const row = await propose(request, tag, 'waiting', chatId)

  // Leo: no card on Approvals, his chat list doesn't hold the chat, and its address shows nothing of it.
  const listed = page.waitForResponse(r => new URL(r.url()).pathname === '/api/actions' && r.request().method() === 'GET')
  const chats = page.waitForResponse(r => new URL(r.url()).pathname === '/api/chats' && r.request().method() === 'GET')
  await signedIn(page, 'leo', '#/approvals')
  expect((await listed).status()).toBe(200)
  const list = await chats
  expect(list.status()).toBe(200)
  expect(((await list.json()) as { items: { id: string }[] }).items.map(c => c.id)).not.toContain(chatId)
  await expect(page.getByRole('heading', { level: 1, name: 'Approvals' })).toBeVisible()
  await expect(cardOf(page, tag)).toHaveCount(0)
  await open(page, 'leo', `#/chats/${chatId}`)
  await expect(page.locator('[data-composer]')).toBeVisible()
  await expect(page.getByText(title)).toHaveCount(0)
  await expect(page.locator('[data-action-card]')).toHaveCount(0)
  // Nor through the API: the card and its answer are not found for him.
  expect((await call(request, leo, 'GET', `/api/actions/${row.id}`)).status).toBe(404)
  expect((await call(request, leo, 'POST', `/api/actions/${row.id}/answer`, { json: { choice: 'once', ifRev: 1 } })).status).toBe(404)
  expect((await call(request, leo, 'GET', `/api/chats/${chatId}`)).status).toBe(404)
  expect((await cardAs(request, dana, row.id)).state).toBe('waiting')

  // Dana: the card, with a way into her chat.
  await signedIn(page, 'dana', '#/approvals')
  const card = cardOf(page, tag)
  await expectAskAnswers(card)
  await card.getByRole('button', { name: `Open the chat: ${TITLE}` }).click()
  await expect(page).toHaveURL(new RegExp(`#/chats/${chatId}$`))
  await expect(page.getByText(title).first()).toBeVisible()
  // Cleaned up: Dana says no; nothing went out.
  const c = await cardAs(request, dana, row.id)
  const denied = await call(request, dana, 'POST', `/api/actions/${row.id}/answer`, { json: { choice: 'deny', ifRev: c.rev } })
  expect(denied.status, denied.text).toBe(200)
  expect(await writesOf(request, tag)).toEqual([])
})
