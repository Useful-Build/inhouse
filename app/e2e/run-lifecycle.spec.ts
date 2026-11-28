// PR 3, leaving a chat mid-answer (decision D9, H2, M5): the answer finishes in the background and is there, once and
// in order, when the person comes back. Several chats answer at once, Stop in one leaves the others, and deleting an
// answering chat stops it and Undo brings it back with the stopped note. Screenshots of each state go to the report.
// Time runs on Playwright's clock: answers move on with `runFor`, and a paused clock holds an answer mid-way, so no
// check depends on how fast the machine is.
import { expect, test, type Fx } from './support/fx.js'
import type { Page } from '@playwright/test'

async function start(page: Page, fx: Fx, hash = '#/today') {
  await page.clock.install()
  await fx.seed({})
  await page.goto('/?demo' + hash)
}

const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.timeline instanceof DocumentTimeline && a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)))
const shot = async (page: Page, name: string) => { await settled(page); await page.screenshot({ path: test.info().outputPath(`${name}.png`) }) }
const side = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' })
const log = (page: Page) => page.getByRole('log', { name: 'Conversation' })
const msgs = (page: Page, text: string) => log(page).locator('[data-chat-msg]').filter({ hasText: text })
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message Inhouse' })
const stop = (page: Page) => page.locator('[data-composer]').getByRole('button', { name: 'Stop', exact: true })
// The visible thinking line, and any live region with words in it (the empty ones stay mounted so they can announce).
const thinkingRow = (page: Page) => page.locator('main').locator('[data-thinking]').or(page.locator('main').getByRole('status').filter({ hasText: /\S/ }))
const openSide = (page: Page, title: string) => side(page).getByRole('button', { name: title, exact: true }).click()
const toast = (page: Page, text: string) => page.locator('[data-toast]').filter({ hasText: text })
/** Holds the clock: an answer under way stays under way until `resume`. Half a second ahead, so the clock can't have passed it first. */
async function hold(page: Page) {
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 500))
}
async function ask(page: Page, q: string) {
  await composer(page).fill(q)
  await page.keyboard.press('Enter')
  await expect(stop(page)).toBeVisible()
}

const STUCK_Q = 'Which orders are stuck over 3 days?'
const STUCK_A = '3 orders · $556'
const REFUNDS_Q = 'Why did refunds jump this week?'
const REFUNDS_A = 'Refund requests rose'
const STOPPED = 'You stopped your Inhouse agent. Nothing was changed.'
const REFUNDS = 'Why did refunds jump?'
const PAYOUT = "What to feature in Friday's email"

test('Runs: leave a chat mid-answer for another, come back, and the whole answer is there once', async ({ fx, page }) => {
  await start(page, fx, '#/chats/refunds')
  await ask(page, STUCK_Q)
  await openSide(page, PAYOUT)
  // The other chat shows no thinking row and nothing of the first chat's answer.
  await expect(page.getByRole('banner')).toContainText(PAYOUT)
  await expect(thinkingRow(page)).toHaveCount(0)
  await expect(stop(page)).toHaveCount(0)
  // Past the whole answer (about 3 s): it finished in the other chat, not here.
  await page.clock.runFor(5000)
  await expect(side(page).getByRole('button', { name: REFUNDS, exact: true })).not.toHaveAccessibleDescription('Answering now')
  await expect(log(page).getByText(STUCK_A)).toHaveCount(0)
  await shot(page, 'runs-other-chat-while-answering')

  await openSide(page, REFUNDS)
  await expect(log(page).getByText(STUCK_A)).toBeVisible()
  await expect(msgs(page, STUCK_Q)).toHaveCount(1)
  await expect(log(page).getByText(STUCK_A)).toHaveCount(1)
  await expect(log(page).getByText(STOPPED)).toHaveCount(0)
  // In order: the question, then its answer, at the end of the chat.
  const order = await log(page).locator('[data-chat-msg]').allInnerTexts()
  const q = order.findLastIndex(t => t.includes(STUCK_Q))
  expect(order.findIndex((t, i) => i > q && t.includes(STUCK_A))).toBeGreaterThan(q)
  await shot(page, 'runs-back-to-finished-answer')
})

test('Runs: two chats answer at once, each answer in its own chat, and Stop in one leaves the other', async ({ fx, page }) => {
  await start(page, fx, '#/chats/refunds')
  await ask(page, STUCK_Q)
  await openSide(page, PAYOUT)
  await ask(page, REFUNDS_Q)
  await stop(page).click()
  await expect(log(page).getByText(STOPPED)).toBeVisible()
  await page.clock.runFor(5000)
  // Stopped here: no answer came after the note.
  await expect(log(page).getByText(REFUNDS_A)).toHaveCount(0)
  await shot(page, 'runs-stopped-in-payout')

  await openSide(page, REFUNDS)
  await expect(log(page).getByText(STUCK_A)).toBeVisible()
  await expect(log(page).getByText(STOPPED)).toHaveCount(0)

  // Both answering for real this time: each answer lands in its own chat.
  await ask(page, REFUNDS_Q)
  await openSide(page, PAYOUT)
  await ask(page, STUCK_Q)
  await expect(log(page).getByText(STUCK_A)).toBeVisible({ timeout: 15_000 })
  await expect(log(page).getByText(REFUNDS_A)).toHaveCount(0)
  await openSide(page, REFUNDS)
  // The seeded thread has this answer once already; the new one makes two.
  await expect(log(page).getByText(REFUNDS_A)).toHaveCount(2, { timeout: 15_000 })
  await expect(log(page).getByText(STUCK_A)).toHaveCount(1)
  await shot(page, 'runs-two-chats-answered')
})

test('Runs: ask from Today, go to the Library mid-answer, and the chat has the full answer when you come back', async ({ fx, page }) => {
  await start(page, fx)
  await page.getByRole('textbox', { name: 'Ask Inhouse' }).fill(STUCK_Q)
  await page.keyboard.press('Enter')
  await expect(stop(page)).toBeVisible()
  await side(page).getByRole('button', { name: 'Library' }).click()
  // The Library's heading is its place ("All files"), not "Library".
  await expect(page.getByRole('navigation', { name: 'Library places' })).toBeVisible()
  await page.clock.runFor(5000)
  await page.goBack()
  await expect(page.getByRole('banner')).toContainText(STUCK_Q)
  await expect(log(page).getByText(STUCK_A)).toBeVisible()
  await expect(msgs(page, STUCK_Q)).toHaveCount(1)
  await expect(stop(page)).toHaveCount(0)
  await shot(page, 'runs-today-library-back')
})

test('Runs: deleting a chat that answers in the background stops it, and Undo brings it back with the stopped note', async ({ fx, page }) => {
  await start(page, fx, '#/chats/refunds')
  await ask(page, REFUNDS_Q)
  // The clock holds, so the delete lands while the answer is still being written behind the list.
  await hold(page)
  await side(page).getByRole('button', { name: 'See all' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'All chats' })).toBeVisible()
  const row = page.locator('main [data-chat-row]').filter({ has: page.getByRole('button', { name: new RegExp(REFUNDS.replace('?', '\\?')) }) })
  await row.hover()
  await row.getByRole('button', { name: 'Chat actions' }).click()
  await page.getByRole('menu', { name: 'Chat actions' }).getByRole('menuitem', { name: 'Delete' }).click()
  await expect(toast(page, 'Deleted 1 chat')).toBeVisible()
  await toast(page, 'Deleted 1 chat').getByRole('button', { name: 'Undo', exact: true }).click()
  await page.clock.resume()
  await page.clock.runFor(5000)

  await openSide(page, REFUNDS)
  await expect(log(page).getByText(STOPPED)).toBeVisible()
  // The answer stopped with the delete: nothing after the note.
  const texts = await log(page).locator('[data-chat-msg]').allInnerTexts()
  expect(texts.at(-1)).toContain(STOPPED)
  await expect(log(page).getByText(REFUNDS_A)).toHaveCount(1)
  await shot(page, 'runs-deleted-while-answering-undone')
})

test('Runs: the sidebar shows a running dot on a chat answering in the background until it finishes', async ({ fx, page }) => {
  await start(page, fx, '#/chats/refunds')
  await ask(page, STUCK_Q)
  await openSide(page, PAYOUT)
  const refundsRow = side(page).getByRole('button', { name: REFUNDS, exact: true })
  await expect(refundsRow).toHaveAccessibleDescription('Answering now')
  await shot(page, 'runs-sidebar-running-dot')
  await expect(refundsRow).not.toHaveAccessibleDescription('Answering now', { timeout: 15_000 })
})

test('Runs: delete an answer, open another chat, and Undo still brings the answer back', async ({ fx, page }) => {
  await start(page, fx, '#/chats/refunds')
  const answer = msgs(page, REFUNDS_A).last()
  await answer.hover()
  await answer.getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('menu', { name: 'Message actions' }).getByRole('menuitem', { name: 'Delete' }).click()
  await expect(log(page).getByText(REFUNDS_A)).toHaveCount(0)
  await openSide(page, PAYOUT)
  await toast(page, 'Message deleted').getByRole('button', { name: 'Undo', exact: true }).click()
  await openSide(page, REFUNDS)
  await expect(log(page).getByText(REFUNDS_A)).toBeVisible()
  await shot(page, 'runs-delete-answer-undo-elsewhere')
})
