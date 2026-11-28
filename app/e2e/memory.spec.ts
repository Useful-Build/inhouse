// PR 3, phase 1 memory (decision D7, M14) and Reset demo: drafts, a started chat (by its link), what
// was added to it, the model pick and the Library view survive a reload; a chat answering at the reload says so; Reset
// demo clears every one of them and puts the scenario back to Normal, also after a reload. What was added
// to a sample chat survives a reload on First day (no chats there), and the demo clock never runs backwards on a reload.
import { expect, fxFor, test } from './support/fx.js'
import type { Page } from '@playwright/test'

async function start(page: Page, hash = '#/today', scenario = 'Normal') {
  // Time keeps flowing; runFor adds app time on top (the session save, answers), so no real sleep.
  await page.clock.install()
  await fxFor(page, undefined).seed({ scenario })
  await page.goto('/?demo' + hash)
}

const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.timeline instanceof DocumentTimeline && a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)))
const shot = async (page: Page, name: string) => { await settled(page); await page.screenshot({ path: test.info().outputPath(`${name}.png`) }) }
const side = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' })
const log = (page: Page) => page.getByRole('log', { name: 'Conversation' })
const todayBox = (page: Page) => page.getByRole('textbox', { name: 'Ask Inhouse' })
const chatBox = (page: Page) => page.getByRole('textbox', { name: 'Message Inhouse' })
const hash = (page: Page) => page.evaluate(() => location.hash)
const go = (page: Page, h: string) => page.evaluate(x => { location.hash = x }, h)
/** Waits out the session save (debounced 300 ms) before a reload. A reload also saves on pagehide; this keeps it honest. */
const saved = (page: Page) => page.clock.runFor(500)
async function resetDemo(page: Page) {
  await page.getByRole('button', { name: /^Demo switches:/ }).click()
  await page.getByRole('button', { name: 'Reset demo', exact: true }).click()
  await page.getByRole('button', { name: 'Close demo switches' }).click()
}

const Q = 'Which orders are stuck over 3 days?'
const A = '3 orders · $556'
const TODAY_DRAFT = 'Draft I was still writing on Today'
const CHAT_DRAFT = 'And a follow-up I have not sent'

test('Memory: drafts, a started chat by its link and the model pick survive a reload; Reset demo clears them', async ({ page }) => {
  await start(page)
  // Pick a model, then ask from Today: the question starts a chat of its own.
  await page.getByRole('button', { name: 'Model: Smart' }).click()
  await page.getByRole('menuitemradio', { name: /Fast/ }).click()
  await todayBox(page).fill(Q)
  await page.keyboard.press('Enter')
  await expect(log(page).getByText(A)).toBeVisible({ timeout: 15_000 })
  const chatLink = await hash(page)
  expect(chatLink).toMatch(/^#\/chats\/chat-new-/)
  await chatBox(page).fill(CHAT_DRAFT)

  // A Today draft, left there.
  await side(page).getByRole('button', { name: 'Today' }).click()
  await todayBox(page).fill(TODAY_DRAFT)
  await side(page).getByRole('button', { name: 'Library' }).click()
  await saved(page)
  await page.reload()

  await go(page, '#/today')
  await expect(todayBox(page)).toHaveValue(TODAY_DRAFT)
  await expect(page.getByRole('button', { name: 'Model: Fast' })).toBeVisible()
  // The started chat opens by its link, with its answer and its draft, and is still in Recent chats.
  await go(page, chatLink)
  await expect(page.getByRole('banner')).toContainText(Q)
  await expect(log(page).getByText(A)).toBeVisible()
  await expect(log(page).locator('[data-chat-msg]').filter({ hasText: Q })).toHaveCount(1)
  await expect(chatBox(page)).toHaveValue(CHAT_DRAFT)
  await expect(side(page).getByRole('button', { name: Q, exact: true })).toBeVisible()
  expect(await hash(page)).toBe(chatLink)
  await shot(page, 'memory-after-reload-chat')

  // Reset demo clears all of it, and a reload doesn't bring any of it back.
  await resetDemo(page)
  await expect(side(page).getByRole('button', { name: Q, exact: true })).toHaveCount(0)
  await go(page, '#/today')
  await expect(todayBox(page)).toHaveValue('')
  await expect(page.getByRole('button', { name: 'Model: Smart' })).toBeVisible()
  await saved(page)
  await page.reload()
  await expect(todayBox(page)).toHaveValue('')
  await expect(side(page).getByRole('button', { name: Q, exact: true })).toHaveCount(0)
  await go(page, chatLink)
  await expect(page.getByText("That chat isn't available. It may have been deleted.")).toBeVisible()
  await shot(page, 'memory-after-reset')
})

test('Memory: the Library view survives a reload', async ({ page }) => {
  await start(page, '#/library')
  await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: 'List' }).click()
  await saved(page)
  await page.reload()
  await expect(page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: 'List' })).toHaveAttribute('aria-checked', 'true')
  await shot(page, 'memory-library-view')
})

test('Memory: a chat answering when the page reloads keeps its question and says the answer stopped', async ({ page }) => {
  await start(page, '#/chats/payout')
  await chatBox(page).fill(Q)
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-composer]').getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await page.reload()
  await expect(log(page).locator('[data-chat-msg]').filter({ hasText: Q })).toHaveCount(1)
  await expect(log(page).getByText('Your Inhouse agent stopped when the page reloaded. Nothing was changed.')).toBeVisible()
  // Longer than the answer takes: nothing arrives, because no run survives a reload.
  await page.clock.runFor(4000)
  await expect(log(page).getByText(A)).toHaveCount(0)
  // Said once: a second reload doesn't add it again.
  await page.reload()
  await expect(log(page).getByText('Your Inhouse agent stopped when the page reloaded.')).toHaveCount(1)
  await shot(page, 'memory-reload-mid-answer')
})

test('Cap reached: a chat is refused with the cap notice, and a waiting draft can still be approved (decision L-A8)', async ({ page }) => {
  await start(page, '#/today', 'Cap reached')
  // Chats stop at the cap: the question gets the cap notice and no answer.
  await todayBox(page).fill(Q)
  await page.keyboard.press('Enter')
  await page.clock.runFor(4000)
  await expect(log(page).getByText("Your team has reached its spending cap, so this answer didn't run.")).toBeVisible()
  await expect(log(page).getByText(A)).toHaveCount(0)
  // Waiting drafts can still be approved at the cap.
  await go(page, '#/today')
  await page.getByRole('article').filter({ hasText: 'Ridge 30L Pack runs out in 9 days' }).getByRole('button', { name: 'Review' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Approve and send to Kestrel' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Approved. It goes out in 10 seconds.' })).toBeVisible()
})

test('Reset demo puts the scenario back to Normal, clears the change, and stays so after a reload', async ({ page }) => {
  await start(page, '#/today', 'Cap reached')
  await expect(page.getByRole('button', { name: 'Demo switches: Cap reached' })).toBeVisible()
  await expect(page.getByText('Spending cap reached.')).toBeVisible()
  // A change: pin a chat from its sidebar menu.
  const row = side(page).locator('[data-chat-row]').filter({ has: page.getByRole('button', { name: 'Amazon payout gap', exact: true }) })
  await row.hover()
  await row.getByRole('button', { name: 'Chat actions' }).click()
  await page.getByRole('menu', { name: 'Chat actions' }).getByRole('menuitem', { name: 'Pin' }).click()
  await expect(side(page).getByRole('group', { name: 'Pinned' })).toBeVisible()

  await resetDemo(page)
  await expect(page.getByRole('button', { name: 'Demo switches: Normal' })).toBeVisible()
  await expect(page.getByText('Spending cap reached.')).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('6 things need you.')
  await expect(side(page).getByRole('group', { name: 'Pinned' })).toHaveCount(0)
  await shot(page, 'reset-demo-normal')

  await page.reload()
  await expect(page.getByRole('button', { name: 'Demo switches: Normal' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('6 things need you.')
  await expect(side(page).getByRole('group', { name: 'Pinned' })).toHaveCount(0)
})

/** Switches the demo scenario from the demo switches panel. */
async function scenarioTo(page: Page, scenario: string) {
  await page.getByRole('button', { name: /^Demo switches:/ }).click()
  await page.getByRole('dialog', { name: 'Demo switches' }).getByRole('button', { name: scenario, exact: true }).click()
  await page.getByRole('button', { name: 'Close demo switches' }).click()
  await expect(page.getByRole('button', { name: new RegExp(`^Demo switches: \\w+, ${scenario}$`) })).toBeVisible()
}

test('Memory: a message added to a sample chat survives a reload on First day and is there back on Normal', async ({ page }) => {
  // The newest sample chat, opened by the plain #/chats link: the one whose id the store resolves itself.
  await start(page, '#/chats')
  await expect(page.getByRole('banner')).toContainText('Stuck orders over 3 days')
  await expect(log(page).locator('[data-chat-msg]').filter({ hasText: Q })).toHaveCount(1)
  await chatBox(page).fill(Q)
  await page.keyboard.press('Enter')
  await expect(log(page).getByText(A)).toHaveCount(2, { timeout: 15_000 })

  // First day has no chats: reload there, from Today (no chat picked).
  await go(page, '#/today')
  await scenarioTo(page, 'First day')
  await saved(page)
  await page.reload()
  await expect(side(page).locator('[data-chat-row]')).toHaveCount(0)

  // Back on Normal: the newest chat is open again with what was added to it, and a save there keeps it.
  await scenarioTo(page, 'Normal')
  await saved(page)
  await page.reload()
  await go(page, '#/chats/stuck')
  await expect(log(page).locator('[data-chat-msg]').filter({ hasText: Q })).toHaveCount(2)
  await expect(log(page).getByText(A)).toHaveCount(2)
  await shot(page, 'memory-first-day-reload-keeps-sample-chat')
})

test('Memory: the demo clock never runs backwards after a reload, even with nothing written before it', async ({ page }) => {
  await start(page)
  // Half an hour into the demo: the first answer is stamped about 8:30 AM.
  await page.clock.fastForward('30:00')
  await todayBox(page).fill(Q)
  await page.keyboard.press('Enter')
  await expect(log(page).getByText(A)).toBeVisible({ timeout: 15_000 })
  // The stamps of the saved agent messages, as epoch ms (read via fx). Compared as instants, never as a time of day in
  // the test runner's own zone (the demo clock runs in the browser's).
  const chatLink = await hash(page)
  const chatId = chatLink.replace(/^#\/chats\//, '')
  // An answer is saved as one agent message per part (the text, then the table), each stamped.
  const stamps = async () => {
    await expect(log(page)).not.toHaveAttribute('aria-busy', 'true')
    await saved(page)
    const state = await fxFor(page, undefined).saved()
    const extras = state.session.chats?.[chatId]?.extras ?? []
    return extras.filter(m => m.role === 'agent' && m.at).map(m => {
      const ms = typeof m.at === 'string' ? Date.parse(m.at) : m.at!.ms
      if (typeof ms !== 'number' || Number.isNaN(ms)) throw new Error(`A saved stamp that isn't a time: ${JSON.stringify(m.at)}`)
      return ms
    })
  }
  // The demo starts at 8:00 AM on Monday, November 16, 2026 in the browser's local time (src/agent/demo-clock.ts).
  const demoStart = await page.evaluate(() => new Date(2026, 10, 16, 8, 0, 0, 0).getTime())
  const firstAnswer = await stamps()
  expect(firstAnswer.length, 'the first answer is saved with its stamps').toBeGreaterThan(0)
  const first = Math.max(...firstAnswer)
  expect(Math.min(...firstAnswer)).toBeGreaterThanOrEqual(demoStart + 30 * 60_000)

  // Reload with no other write, then ask again in the same chat.
  await page.reload()
  await go(page, chatLink)
  await expect(log(page).getByText(A)).toHaveCount(1)
  // The time marker heading the chat reads the demo's time, in the browser's zone (the demo shows the device's).
  await expect(log(page).locator('[data-thread-marker="time"]').first()).toHaveText(/^Today 8:[3-5]\d\sAM$/)
  await chatBox(page).fill(Q)
  await page.keyboard.press('Enter')
  await expect(log(page).getByText(A)).toHaveCount(2, { timeout: 15_000 })
  const both = await stamps()
  // The first answer's stamps are unchanged, and the second answer's are saved after them: never one stamp compared with itself.
  expect(both.slice(0, firstAnswer.length)).toEqual(firstAnswer)
  const secondAnswer = both.slice(firstAnswer.length)
  expect(secondAnswer.length, 'the second answer is saved with its stamps').toBeGreaterThan(0)
  expect(Math.min(...secondAnswer)).toBeGreaterThanOrEqual(first)
  await shot(page, 'memory-clock-after-reload')
})
