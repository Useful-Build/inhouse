// PR 3, what the demo agent does (H4, H5, D8, M18): a question never makes a routine, a request with a schedule and a
// time makes exactly one (Regenerate updates it instead of adding a second), an off-script question gets the D8 answer,
// Regenerate on a seeded chat gives that chat's own answer, the weekly report notification opens the chat that holds
// the report, and an unknown link says so. Screenshots of each answer go to the report.
import { expect, fxFor, test } from './support/fx.js'
import { routeReady } from './support/clients/mock.js'
import type { Page } from '@playwright/test'

async function start(page: Page, hash = '#/today') {
  await fxFor(page, undefined).seed({})
  await fxFor(page, undefined).open(hash)
}

const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.timeline instanceof DocumentTimeline && a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)))
const shot = async (page: Page, name: string) => { await settled(page); await page.screenshot({ path: test.info().outputPath(`${name}.png`) }) }
const side = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' })
const log = (page: Page) => page.getByRole('log', { name: 'Conversation' })
const msgs = (page: Page) => log(page).locator('[data-chat-msg]')
const stop = (page: Page) => page.locator('[data-composer]').getByRole('button', { name: 'Stop', exact: true })
const routineCards = (page: Page) => log(page).getByText('Created routine')
/** Asks from Today and waits for the answer to finish. */
async function askFromToday(page: Page, q: string) {
  await page.getByRole('textbox', { name: 'Ask Inhouse' }).fill(q)
  await page.keyboard.press('Enter')
  await expect(stop(page)).toBeVisible()
  await expect(stop(page)).toHaveCount(0, { timeout: 15_000 })
}
/** The routines a person made in chats, as the Routines page lists them. */
async function routineNames(page: Page) {
  await side(page).getByRole('button', { name: 'Routines' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Routines' })).toBeVisible()
  await routeReady(page)
  return page.locator('main').getByRole('button', { name: /^Actions for / }).count()
}
/** Picks a scenario in the demo switches (the demo has no stages since decision A13). */
async function demoTo(page: Page, pick: { scenario: string }) {
  await page.getByRole('button', { name: /^Demo switches:/ }).click()
  const demo = page.getByRole('dialog', { name: 'Demo switches' })
  await demo.getByRole('button', { name: pick.scenario, exact: true }).click()
  await page.getByRole('button', { name: 'Close demo switches' }).click()
  await expect(page.getByRole('button', { name: /^Demo switches:/ })).toHaveAttribute('aria-label', `Demo switches: ${pick.scenario}`)
}
/** Regenerates the newest answer that holds `text`, and waits for the new answer to finish. */
async function regenerate(page: Page, text: string) {
  const answer = msgs(page).filter({ hasText: text }).last()
  await answer.hover()
  await answer.getByRole('button', { name: 'Regenerate' }).click()
  await expect(stop(page)).toBeVisible()
  await expect(stop(page)).toHaveCount(0, { timeout: 15_000 })
}

test('Mock: "How much did we refund each customer last week?" is a question, so it makes no routine', async ({ page }) => {
  await start(page, '#/routines')
  const before = await page.locator('main').getByRole('button', { name: /^Actions for / }).count()
  await side(page).getByRole('button', { name: 'Today' }).click()
  await askFromToday(page, 'How much did we refund each customer last week?')
  await expect(routineCards(page)).toHaveCount(0)
  await expect(msgs(page).last()).not.toContainText(/routine/i)
  await shot(page, 'mock-question-no-routine')
  expect(await routineNames(page)).toBe(before)
})

test('Mock: a schedule and a time make exactly one routine, Regenerate updates it, and a schedule without a time asks for one', async ({ page }) => {
  await start(page, '#/routines')
  const before = await page.locator('main').getByRole('button', { name: /^Actions for / }).count()
  await side(page).getByRole('button', { name: 'Today' }).click()
  await askFromToday(page, 'Every Friday at 4pm, send me the refund totals')
  await expect(routineCards(page)).toHaveCount(1)
  await shot(page, 'mock-routine-made')

  // Regenerate: the new answer's routine replaces the old one, it isn't a second.
  const answer = msgs(page).filter({ hasText: 'Created routine' }).last()
  await answer.hover()
  await answer.getByRole('button', { name: 'Regenerate' }).click()
  await expect(stop(page)).toHaveCount(0, { timeout: 15_000 })
  await expect(routineCards(page)).toHaveCount(1)
  expect(await routineNames(page)).toBe(before + 1)

  // A schedule with no time: the agent asks what time and makes nothing.
  await side(page).getByRole('button', { name: 'Today' }).click()
  await askFromToday(page, 'Remind me every Friday to check the refund totals')
  await expect(routineCards(page)).toHaveCount(0)
  await expect(msgs(page).last()).toContainText('What time should it run?')
  await shot(page, 'mock-schedule-asks-for-time')
  expect(await routineNames(page)).toBe(before + 1)
})

test('Mock: a routine request reads its time and name like a person would, and a polite request counts', async ({ page }) => {
  await start(page)
  const card = () => log(page).locator('[data-chat-msg]').filter({ hasText: 'Created routine' }).last()
  // Morning means AM, night means PM, whatever the hour; the name keeps the person's capitals.
  await askFromToday(page, 'Every morning at 6, list late orders')
  await expect(card()).toContainText('6:00 AM')
  await expect(card()).toContainText('List late orders')
  await side(page).getByRole('button', { name: 'Today' }).click()
  await askFromToday(page, 'Every night at 11, check Gorgias for new tickets')
  await expect(card()).toContainText('11:00 PM')
  await expect(card()).toContainText('Check Gorgias for new')
  // "Can you ... ?" with a schedule is a request, not a question.
  await side(page).getByRole('button', { name: 'Today' }).click()
  await askFromToday(page, 'Can you send me the refund totals every Friday at 4pm?')
  await expect(card()).toContainText('4:00 PM')
  await expect(card()).toContainText('Send me the refund')
  await shot(page, 'mock-routine-polite')
  // A time that can't be is asked about, not guessed.
  await side(page).getByRole('button', { name: 'Today' }).click()
  await askFromToday(page, 'Every Monday at 25, check stock')
  await expect(routineCards(page)).toHaveCount(0)
  await expect(msgs(page).last()).toContainText('What time should it run?')
  // A question about skills makes none.
  await side(page).getByRole('button', { name: 'Today' }).click()
  await askFromToday(page, 'Any new skill ideas?')
  await expect(log(page).getByText('Done. I\'ve saved that as a skill')).toHaveCount(0)
})

test('Mock: with no comma, a bare "at N" right after the schedule is the time; a unit after it, two weekdays or "explain" make none', async ({ page }) => {
  await start(page)
  const card = () => log(page).locator('[data-chat-msg]').filter({ hasText: 'Created routine' }).last()
  const today = () => side(page).getByRole('button', { name: 'Today' }).click()
  const made: [string, string, string][] = [
    ['Every morning at 6 summarize refunds', '6:00 AM', 'Summarize refunds'],
    ['every night at 11 check stock', '11:00 PM', 'Check stock'],
    ['Each weekday at 8 check ShipBob stuck orders', '8:00 AM', 'Check ShipBob stuck orders'],
    ['every Monday at 9 send the weekly report', '9:00 AM', 'Monday'],
    // The routine example without its comma.
    ['Every Monday at 7 list products under 3 weeks of stock', '7:00 AM', 'List products under'],
    // "o'clock" and "sharp" belong to the time, not the name.
    ["Every day at 5 o'clock send the numbers", '5:00 PM', 'Send the numbers'],
  ]
  for (const [q, time, text] of made) {
    await askFromToday(page, q)
    await expect(card()).toContainText(time)
    await expect(card()).toContainText(text)
    await today()
  }
  await shot(page, 'mock-routine-no-comma')
  // A unit after the number, two weekdays, or a polite "explain" question: asked about or answered, never a routine.
  for (const q of ['Every Monday at 3 weeks of stock reorder Ridge', 'every Tuesday and Thursday at 9am check payouts']) {
    await askFromToday(page, q)
    await expect(routineCards(page)).toHaveCount(0)
    await expect(msgs(page).last()).toContainText('What time should it run?')
    await today()
  }
  await askFromToday(page, 'Can you explain how routines run every morning at 7?')
  await expect(routineCards(page)).toHaveCount(0)
})

test('Mock: the time right after the schedule wins, a part of the day may sit between, only the schedule\'s weekday counts, and counts aren\'t hours', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await start(page)
  const card = () => log(page).locator('[data-chat-msg]').filter({ hasText: 'Created routine' }).last()
  const today = () => side(page).getByRole('button', { name: 'Today' }).click()
  const made: [string, string, string][] = [
    // A weekday the task names isn't a second schedule day.
    ['every Monday at 9am send the Friday numbers', '9:00 AM', 'Monday'],
    // A later time in the task doesn't win over the schedule's, and "the night before" isn't the schedule's part of the day.
    ['every day at 7 tell me what sold at 6 the night before', '7:00 AM', 'Tell me what sold'],
    ['every Monday morning at 6 run the numbers', '6:00 AM', 'Run the numbers'],
  ]
  for (const [q, time, text] of made) {
    await askFromToday(page, q)
    await expect(card()).toContainText(time)
    await expect(card()).toContainText(text)
    await today()
  }
  await shot(page, 'mock-routine-schedule-time-wins')
  // A count after the number: asked about, never a routine at that hour.
  for (const q of ['every Monday at 3 orders late email Mei', 'every Monday at 2 SKUs low reorder']) {
    await askFromToday(page, q)
    await expect(routineCards(page)).toHaveCount(0)
    await expect(msgs(page).last()).toContainText('What time should it run?')
    await today()
  }
  // Copy carries a plain space where the screen keeps "9 AM" together with a no-break space.
  await askFromToday(page, 'Remind me every Friday to check payouts')
  await log(page).getByRole('button', { name: 'Copy message' }).last().click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('like "every Friday at 9 AM"')
  expect(await page.evaluate(() => navigator.clipboard.readText())).not.toContain('\u00a0')
})

test("Mock: Regenerate takes back a routine the new answer doesn't make and its Undo brings it back; a skill is never taken back", async ({ page }) => {
  await page.clock.install()
  await start(page, '#/routines')
  const before = await page.locator('main').getByRole('button', { name: /^Actions for / }).count()
  const routine = page.locator('main').getByRole('button', { name: 'Actions for Check stock', exact: true })
  await side(page).getByRole('button', { name: 'Today' }).click()
  await askFromToday(page, 'Every morning at 6 check stock')
  await expect(routineCards(page)).toHaveCount(1)
  // Loading reads nothing yet, so it makes no routine: Regenerate there takes back the one this answer made, as a delete.
  await demoTo(page, { scenario: 'Loading' })
  await regenerate(page, 'Created routine')
  await expect(routineCards(page)).toHaveCount(0)
  // Held from here, so "Asking again" keeps its Undo while Routines is checked.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 500))
  await demoTo(page, { scenario: 'Normal' })
  expect(await routineNames(page)).toBe(before)
  await expect(routine).toHaveCount(0)
  await page.locator('[data-toast]').filter({ hasText: 'Asking again' }).getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(routine).toHaveCount(1)
  expect(await page.locator('main').getByRole('button', { name: /^Actions for / }).count()).toBe(before + 1)
  await shot(page, 'mock-take-back-undone')
  await page.clock.resume()

  // A skill stays when the answer that made it is asked again and makes none (Loading reads nothing yet).
  await side(page).getByRole('button', { name: 'Today' }).click()
  await askFromToday(page, 'Make a skill that drafts the stock report')
  await expect(log(page).getByText("Done. I've saved that as a skill")).toBeVisible()
  await demoTo(page, { scenario: 'Loading' })
  // The turn's actions sit under its last part, the skill card.
  await regenerate(page, 'Created skill')
  await expect(log(page).getByText("Done. I've saved that as a skill")).toHaveCount(0)
  await demoTo(page, { scenario: 'Normal' })
  await side(page).getByRole('button', { name: 'Skills' }).click()
  await expect(page.locator('main').getByText('Drafts the stock report', { exact: true })).toBeVisible()
})

test('Mock: a failed answer keeps the routine the earlier one made, and Try again updates it instead of adding a second', async ({ page }) => {
  await start(page, '#/routines')
  const before = await page.locator('main').getByRole('button', { name: /^Actions for / }).count()
  await side(page).getByRole('button', { name: 'Today' }).click()
  await askFromToday(page, 'Every morning at 6 summarize refunds')
  await expect(routineCards(page)).toHaveCount(1)
  // Gorgias's login expired: asked again, the answer fails and the routine stays.
  await demoTo(page, { scenario: 'Tool disconnected' })
  await regenerate(page, 'Created routine')
  const retry = log(page).getByRole('button', { name: 'Try again' })
  await expect(retry).toBeVisible()
  await demoTo(page, { scenario: 'Normal' })
  await retry.click()
  await expect(stop(page)).toBeVisible()
  await expect(stop(page)).toHaveCount(0, { timeout: 15_000 })
  await expect(routineCards(page)).toHaveCount(1)
  await shot(page, 'mock-try-again-updates-routine')
  expect(await routineNames(page)).toBe(before + 1)
  await expect(page.locator('main').getByRole('button', { name: 'Actions for Summarize refunds', exact: true })).toHaveCount(1)
})

test('Mock: an off-script question gets the "can\'t answer from your tools" answer, never "sample data"', async ({ page }) => {
  await start(page)
  await askFromToday(page, 'What is the weather like in Lisbon?')
  // The D8 words: what it can't answer, then the six tools by name. One card per answer (D2): the suggested questions
  // sit as chips inside the same card, after the text.
  const answer = msgs(page).last()
  await expect(answer.getByRole('button', { name: 'Which orders are stuck over 3 days?' })).toBeVisible()
  await expect(answer).toContainText("can't answer that from your tools yet")
  await expect(answer).toContainText('Shopify, Amazon, ShipBob, Xero, Gorgias and Meta Ads')
  await expect(log(page)).not.toContainText(/\bdemo\b|\bmock\b/i)
  await expect(log(page)).not.toContainText(/sample data/i)
  await shot(page, 'mock-off-script')
})

test('Mock: the off-script answer offers the suggested questions as chips, and a chip asks it', async ({ page }) => {
  await start(page)
  await askFromToday(page, 'What is the weather like in Lisbon?')
  const chip = log(page).getByRole('button', { name: 'Which orders are stuck over 3 days?' })
  await expect(chip).toBeVisible()
  await chip.click()
  await expect(log(page).getByText('3 orders · $556')).toBeVisible({ timeout: 15_000 })
  await shot(page, 'mock-off-script-chips')
})

test("Mock: Regenerate on a seeded chat gives that chat's own answer", async ({ page }) => {
  await start(page, '#/chats/numbers')
  const answer = msgs(page).filter({ hasText: '$61,840' })
  await expect(answer).toHaveCount(1)
  await answer.hover()
  await answer.getByRole('button', { name: 'Regenerate' }).click()
  await expect(stop(page)).toBeVisible()
  await expect(stop(page)).toHaveCount(0, { timeout: 15_000 })
  await expect(msgs(page).filter({ hasText: '$61,840' })).toHaveCount(1)
  await expect(log(page)).not.toContainText(/sample data/i)
  await shot(page, 'mock-regenerate-seeded')
})

test('Mock: the weekly report notification opens the chat that holds the report', async ({ page }) => {
  await start(page)
  await page.getByRole('button', { name: /^Notifications/ }).click()
  await page.getByRole('dialog', { name: 'Notifications' }).getByRole('button', { name: /weekly numbers report is ready/ }).click()
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/chats/numbers')
  await expect(log(page).getByText('$61,840')).toBeVisible()
  // It opens the report; it doesn't ask a new question.
  await expect(stop(page)).toHaveCount(0)
  await expect(side(page).getByRole('button', { name: "Summarize this week's numbers", exact: true })).toHaveCount(0)
  await shot(page, 'mock-weekly-report-notification')
})

test('Links: First day picked with a sample chat open falls back quietly, with no "may have been deleted" notice', async ({ page }) => {
  await page.clock.install() // time keeps flowing; runFor adds app time on top, so no real sleep
  await start(page, '#/chats/refunds')
  await expect(msgs(page).first()).toBeVisible()
  await demoTo(page, { scenario: 'First day' })
  await expect.poll(() => page.evaluate(() => location.hash)).not.toContain('refunds')
  // The notice would show just after the fallback: give it the time before checking there is none.
  await page.clock.runFor(1000)
  await expect(page.getByRole('textbox', { name: 'Message Inhouse' })).toBeVisible() // the new chat First day falls back to is drawn, so no toast is a real absence
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/chats/new')
  await expect(page.locator('[data-toast]').filter({ hasText: 'may have been deleted' })).toHaveCount(0)
})

test("Links: an unknown page, tool, settings tab or chat lands where it did and says so; #/chats doesn't", async ({ page }) => {
  await page.clock.install() // time keeps flowing; runFor adds app time on top, so no real sleep
  await start(page, '#/nope')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('6 things need you.')
  await expect(page.locator('[data-toast]').filter({ hasText: "That page doesn't exist. You're on Today." })).toBeVisible()
  await shot(page, 'links-unknown-page')

  await page.evaluate(() => { location.hash = '#/tools/bogus' })
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tools')
  await expect(page.locator('[data-toast]').filter({ hasText: "That page doesn't exist. You're on Tools." })).toBeVisible()

  await page.evaluate(() => { location.hash = '#/settings/bogus' })
  await expect(page.locator('[data-toast]').filter({ hasText: "That page doesn't exist. You're on General." })).toBeVisible()

  await page.evaluate(() => { location.hash = '#/chats/no-such-chat' })
  await expect(page.locator('[data-toast]').filter({ hasText: "That chat isn't available. It may have been deleted." })).toBeVisible()
  await shot(page, 'links-unknown-chat')

  // A plain #/chats is the newest chat, not an error: the toasts so far are dismissed and no new one comes.
  const dismiss = page.locator('[data-toast]').getByRole('button', { name: 'Dismiss' })
  while (await dismiss.count()) await dismiss.first().click()
  await page.evaluate(() => { location.hash = '#/chats' })
  await expect(page.getByRole('log', { name: 'Conversation' })).toBeVisible()
  await page.clock.runFor(500)
  await expect(page.locator('[data-toast]')).toHaveCount(0)
})
