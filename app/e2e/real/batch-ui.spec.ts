// Stage 1 M3-U (N22, N33) on the test build: a 450-item batch card, seeded through the test-fakes hook (the outbox's own
// `request` as Dana, a member, in a chat of hers), read in full and approved from the screen, on desktop and phone, in
// both themes. It would fail if:
//  - Approvals didn't show the batch with its first 10 lines, "and 440 more", its totals and an Approve naming exactly
//    what it covers ("Approve these 450: 450 orders");
//  - "See all 450" didn't list all 450 items in order, paged in from route 125;
//  - an approval covered anything but the count and totals the sheet showed: here 3 items join the batch while the sheet
//    is open, the approval still covers the 450 shown (the server's `upTo` and totals), and the 3 wait on a new card;
//  - the approved 450 didn't all go out (the fake store's log) or the card didn't settle on "Sent. 450 of 450 went out";
//  - any screen failed axe (WCAG 2.1 A and AA) in light or dark, or scrolled sideways.
// Seeding: with no permission, the first 5 calls in the chat are waiting single cards; every call after them joins the
// chat's one collecting batch (N22, a 6th waiting card). The ceiling is set only through the hook and turned off again
// after (and before, in case a killed run left it on); the cards this spec leaves waiting are answered No at the end.
import AxeBuilder from '@axe-core/playwright'
import type { APIRequestContext, Page } from '@playwright/test'
import { expect, test } from '../support/test-build/index.js'
import { open, signInAs } from '../support/clients/real.js'
import { actor, call, me } from '../api/kit.ts'
import { createChat } from '../api/chat-kit.ts'
import { hook, hubCall, requestAction, setCeiling } from '../api/fakes-kit.ts'
import { SHOPIFY_READ } from '../support/test-build/shopify-read.ts'

const TAG_ADD = 'shopify.order.tag_add'
const dana = actor('memberA')
const phone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 600
test.describe.configure({ mode: 'serial' })

let danaId = ''
let chatId = ''
let batchId = ''
let prefix = ''
/** Call `k`'s arguments: one of the fake store's orders (9001 to 9003) and a tag of its own, so no two share a payload. */
const callArgs = (k: number) => ({ orderIds: [`gid://shopify/Order/${9001 + (k % 3)}`], tags: [`${prefix}-${k}`] })

interface Card { id: string; rev: number; state: string; result?: string; batch?: { itemCount: number; totals: { records: number; units: number } } }
const danaCards = async (request: APIRequestContext, q: string): Promise<Card[]> => {
  const r = await call(request, dana, 'GET', `/api/actions?${q}`)
  expect(r.status, r.text).toBe(200)
  return r.json.items as Card[]
}
const writesOf = async (request: APIRequestContext): Promise<number> => {
  const r = await hook(request, { op: 'state' })
  expect(r.status, r.text).toBe(200)
  return (r.json.shopifyWrite as { writes: { variables: { tags?: string[] } }[] }).writes.filter(w => w.variables.tags?.some(t => t.startsWith(`${prefix}-`))).length
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000)
  danaId = (await me(request, dana)).memberId
  await setCeiling(request, TAG_ADD, false)
  expect((await hubCall(request, SHOPIFY_READ.method, SHOPIFY_READ.name, SHOPIFY_READ.args)).ok).toBe(true)
  const fault = await hook(request, { op: 'set', shopifyWrite: { faults: { [TAG_ADD]: 'succeed' } } })
  expect(fault.status, fault.text).toBe(200)
  const r = await hook(request, { op: 'ceiling', operation: TAG_ADD, enabled: true, perDayMax: 200, unitsMax: 100, bulkThreshold: 5, batchMax: 500 })
  expect(r.status, r.text).toBe(200)
  // No permission of Dana's left (another spec's), so every call asks.
  for (const p of (await call(request, dana, 'GET', '/api/permissions')).json.items as { id: string; rev: number; operation: string; can: { remove: boolean } }[]) {
    if (p.operation === TAG_ADD && p.can.remove) await call(request, dana, 'POST', `/api/permissions/${p.id}/remove`, { json: { ifRev: p.rev } })
  }
  prefix = `m3u-${test.info().project.name}-${Date.now().toString(36)}`
  chatId = await createChat(request, dana)
  for (let k = 1; k <= 455; k++) {
    const res = await requestAction(request, { memberId: danaId, chatId }, TAG_ADD, callArgs(k))
    expect(res.outcome, `call ${k}: ${JSON.stringify(res)}`).toBe(k <= 5 ? 'waiting' : 'collected')
    if (k > 5) batchId ||= res.action.id
  }
})

test.afterAll(async ({ request }) => {
  // Every card this spec left waiting is answered No (a batch with the totals it holds), so no later spec finds one.
  for (const c of await danaCards(request, `states=waiting&chatId=${chatId}`)) {
    const covers = c.batch ? { upTo: c.batch.itemCount, totals: { records: c.batch.totals.records, units: c.batch.totals.units } } : {}
    await call(request, dana, 'POST', `/api/actions/${c.id}/answer`, { json: { choice: 'deny', ifRev: c.rev, ...covers } })
  }
  await setCeiling(request, TAG_ADD, false)
})

async function checkBothThemes(page: Page, name: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    if (scheme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
    await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running' || !(a.timeline instanceof DocumentTimeline) || a.effect?.getTiming().iterations === Infinity))
    const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
    expect(violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`), `${name} ${scheme}`).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${name} ${scheme} scrolls sideways`).toBe(true)
    await page.screenshot({ path: test.info().outputPath(`${name}-${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

const batchCard = (page: Page) => page.locator(`[data-action-id="${batchId}"]`)

test('Approvals shows the 450-item batch: its first lines, its totals and an Approve that names what it covers', async ({ page, context }) => {
  await signInAs(context, 'dana')
  await open(page, 'dana', '#/approvals')
  const card = batchCard(page)
  await expect(card).toBeVisible()
  await expect(card).toContainText('Needs your approval')
  await expect(card.locator('[data-card-lines] li')).toHaveCount(11)
  await expect(card.locator('[data-card-lines] li').first()).toContainText(`add ${prefix}-6`)
  await expect(card.locator('[data-card-lines] li').last()).toHaveText('and 440 more')
  await expect(card.locator('[data-batch-totals]')).toContainText('In all: 450 orders')
  await expect(card.locator('[data-card-actions] button')).toHaveText(['Approve these 450: 450 orders', 'No'])
  await card.scrollIntoViewIfNeeded()
  await checkBothThemes(page, `batch-approvals-${phone(page) ? 'phone' : 'desktop'}`)
})

test('See all reads the 450 in full; items joining while it is open go to a new card, and the approval covers the 450 shown', async ({ page, context, request }) => {
  test.setTimeout(300_000)
  await signInAs(context, 'dana')
  await open(page, 'dana', '#/approvals')
  const card = batchCard(page)
  await card.getByRole('button', { name: /^See all 450: / }).click()
  const sheet = page.locator('[data-batch-sheet]')
  await expect(sheet).toBeVisible()
  const items = sheet.locator('[data-item]')
  await expect(items).toHaveCount(450)
  await expect(items.first()).toContainText(`add ${prefix}-6`)
  await expect(items.last()).toContainText(`add ${prefix}-455`)
  await items.nth(220).scrollIntoViewIfNeeded()
  await checkBothThemes(page, `batch-sheet-${phone(page) ? 'phone' : 'desktop'}`)

  // Three more calls join the batch while the sheet is open: the card reads itself and the sheet says so, but its
  // Approve still names the 450 it showed.
  for (let k = 456; k <= 458; k++) expect((await requestAction(request, { memberId: danaId, chatId }, TAG_ADD, callArgs(k))).outcome).toBe('collected')
  await expect(sheet.locator('[data-more-arrived]')).toHaveText('3 more arrived while you looked. They wait for their own OK.', { timeout: 15_000 })
  await expect(sheet.locator('[data-item]')).toHaveCount(450)
  await sheet.getByRole('button', { name: 'Approve these 450: 450 orders' }).click()
  await expect(page.locator('[data-toast]').filter({ hasText: 'Approved 450. They start going out in a few seconds.' })).toBeVisible()
  await expect(card).toHaveAttribute('data-action-card', /approved|sending|sent/)
  await expect(card.locator('[data-left-over]')).toContainText('3 more arrived while you looked.')

  // The server holds exactly what was shown: 450 approved, and the 3 on a new waiting card of their own.
  const answered = (await call(request, dana, 'GET', `/api/actions/${batchId}`)).json as Card
  expect(answered.batch).toMatchObject({ itemCount: 450, totals: { records: 450, units: 450 } })
  const rest = (await danaCards(request, `states=waiting&chatId=${chatId}`)).filter(c => c.batch)
  expect(rest.map(c => c.batch!.itemCount)).toEqual([3])

  // All 450 go out after the hold, in passes; the card reads itself until it settles.
  await expect.poll(() => writesOf(request), { timeout: 180_000, intervals: [2_000] }).toBe(450)
  await expect(card).toHaveAttribute('data-action-card', 'sent', { timeout: 60_000 })
  await expect(card).toContainText('Sent. 450 of 450 went out')
})
