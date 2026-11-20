// Ship spec for the agent seam (P1): the demo reads exactly as it did before times, amounts and the client moved behind
// the seam. Recorded at 1440x900 and 390x844 on the demo preview. After the first load, every page is opened through the
// UI, as a person would (sidebar buttons, "See all", "New chat"; on a phone the sidebar is the drawer behind Menu).
import { expect, test, type Fx } from '../support/fx.js'
import type { Page } from '@playwright/test'

const phone = () => test.info().project.name === 'ship-phone'

const main = (page: Page) => page.getByRole('main')
const h1 = (page: Page) => page.getByRole('heading', { level: 1 })
const card = (page: Page, title: string) => page.getByRole('article').filter({ hasText: title })
const toast = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text })

// The Kestrel reorder, as src/agent/sample-data/problems.json has it (problem `stock`): copied, since a spec reads sample
// data only through `fx` and `fx` doesn't carry the problems.
const KESTREL = 'Ridge 30L Pack runs out in 9 days'
const KESTREL_APPROVER = 'Dana Kim usually signs off orders over $5,000'
const KESTREL_MEMORY = 'Remembered: Kestrel ships in 14 days'
const KESTREL_CTA = 'Approve and send to Kestrel'
const KESTREL_SENT = 'Reorder of 600 sent to Kestrel Supply'

/**
 * What each Today card's amount read before P1 (the display strings of src/lib/format.golden.json, keys
 * `problems.<id>.cost`, captured from main before any formatter changed). The page must still write exactly these through
 * format.ts's fmtMoney from the new `{ minor, currency }` amounts.
 */
const GOLDEN_COST: Record<string, string> = {
  'Trail Shell Jacket (M, Olive) is oversold by 5': '$1,190',
  [KESTREL]: '$8,400',
  'Amazon paid out $1,240 less than expected': '$1,240',
  'PO-1187 from Kestrel is 6 days late': '$5,100',
  '11 returns are not restocked': '$1,030',
  'Order #4821 is stuck for 4 days': '$312',
}

/** Seeds the demo at Act, with the sample's own clock, then opens Today as a first visit. */
async function start(page: Page, fx: Fx) {
  await fx.seed({ stage: 'Act', demo: { ambient: 'Always' } })
  await fx.open('#/today')
  await expect(h1(page)).toContainText(`Good morning, ${fx.names.user.name.split(' ')[0]}.`)
}

/** The Kestrel card's Review panel, then its approve button. */
async function approve(page: Page) {
  await card(page, KESTREL).getByRole('button', { name: 'Review' }).click()
  await page.getByRole('dialog').getByRole('button', { name: KESTREL_CTA }).click()
}

/** The sidebar. On a phone it is a drawer behind the Menu button, so it is opened first. */
async function sidebar(page: Page) {
  if (phone()) await page.getByRole('button', { name: 'Menu' }).click()
  const side = page.getByRole('complementary', { name: 'Sidebar' })
  await expect(side).toBeVisible()
  return side
}

async function goTo(page: Page, name: string) {
  const side = await sidebar(page)
  await side.getByRole('button', { name, exact: true }).click()
}

/** Opens the demo switches. The dashed button sits in the top bar at both sizes. */
async function switches(page: Page) {
  await page.getByRole('button', { name: /^Demo switches:/ }).click()
  const panel = page.getByRole('dialog', { name: 'Demo switches' })
  await expect(panel).toBeVisible()
  return panel
}

test('S1: Today opens at the morning start with the same six things and the same dollar amounts', async ({ fx, page }) => {
  await start(page, fx)
  await expect(h1(page)).toContainText('6 things need you. A fix is drafted for each.')
  await expect(page.getByRole('article')).toHaveCount(6)
  // Every card's amount goes through the money formatter: it reads as it did before P1.
  for (const [title, cost] of Object.entries(GOLDEN_COST)) await expect(card(page, title), title).toContainText(cost)
  // The Kestrel reorder spends money: its panel carries the sign-off amount.
  await card(page, KESTREL).getByRole('button', { name: 'Review' }).click()
  const panel = page.getByRole('dialog')
  await expect(panel).toContainText('Spends money')
  await expect(panel).toContainText(KESTREL_APPROVER)
  await expect(panel).toContainText(KESTREL_MEMORY)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // The morning check, in Activity: its 6:00 AM time and its count, on the day the demo clock calls Today, and the day
  // before it ("Fri, Nov 13" is the weekday before Mon, Nov 16).
  await goTo(page, 'Activity')
  await expect(h1(page)).toHaveText('Activity')
  const morning = page.locator('button[data-activity-row]').filter({ hasText: 'Morning check: read' })
  await expect(morning).toContainText('found 6 things')
  await expect(morning).toContainText(/6:00\s*AM/)
  await expect(main(page).locator('section').filter({ hasText: 'Fri, Nov 13' }).first()).toBeVisible()
  // The demo's day is Mon, Nov 16: a file made this morning shows it, with its time, from the demo clock.
  await goTo(page, 'Library')
  await page.getByRole('list', { name: 'Files' }).getByRole('listitem').filter({ hasText: 'stuck-orders-over-3-days.csv' }).first().click()
  await expect(page.getByRole('dialog', { name: 'File: stuck-orders-over-3-days.csv' })).toContainText(/Mon, Nov 16, 7:43\s*AM/)
})

test('S2: A suggested question streams its answer with the orders table, and times and amounts read as before', async ({ fx, page }) => {
  await start(page, fx)
  // "#/chats" opens the newest chat, so a person starts a new one: its empty state offers the suggestions.
  await goTo(page, 'New chat')
  await expect(page.getByRole('heading', { name: 'What do you want to know?' })).toBeVisible()
  await page.getByRole('button', { name: 'Which orders are stuck over 3 days?' }).click()
  const log = page.getByRole('log', { name: 'Conversation' })
  await expect(log.getByText('3 orders · $556')).toBeVisible({ timeout: 15_000 })
  await expect(log.getByText('Not picked at ShipBob')).toBeVisible()
  await expect(log.getByText('$312')).toBeVisible()
  // The answer's trace keeps its length.
  // The answer bar reads steps, duration and the stamp from the demo clock (8:00 AM, give or take the run's seconds).
  const bar = log.getByRole('button', { name: /6 steps/ }).last()
  await expect(bar).toContainText(/6 steps · 9\.4s · 8:0\d\s*AM/)
  await bar.click()
  await expect(page.getByRole('dialog', { name: /What your Inhouse agent did/ })).toContainText('9.4s')
})

test('S3: Approving a fix shows the hold, Undo stops it, and Activity shows the stamped time on the demo clock', async ({ fx, page }) => {
  await start(page, fx)
  // The demo clock reads 8:00 AM plus the time since the demo started. Hold the page clock there: the 10 s hold is
  // moved by runFor only, and every stamp says 8:00 AM however long the run took.
  const started = (await fx.saved()).demo.demoStartedAt
  expect(typeof started).toBe('number')
  await page.clock.install({ time: started as number })
  await page.clock.pauseAt((started as number) + 20_000)

  const kestrel = card(page, KESTREL)
  await approve(page)
  const held = toast(page, 'Approved. It goes out in 10 seconds.')
  await expect(held).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(kestrel).toContainText('going out')
  // Undo stops the hold: the card is back, and nothing goes out when the hold would have ended.
  await held.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(kestrel).not.toContainText('going out')
  await expect(kestrel.getByRole('button', { name: 'Review' })).toBeVisible()
  await page.clock.runFor(12_000)
  await expect(kestrel).not.toContainText('going out')
  await expect(kestrel.getByRole('button', { name: 'Review' })).toBeVisible()
  // Approve again and let it go out; Activity logs it with the demo clock's time.
  await approve(page)
  await page.keyboard.press('Escape')
  await page.clock.runFor(12_000)
  await expect(kestrel).not.toContainText('going out')
  await goTo(page, 'Activity')
  await expect(h1(page)).toHaveText('Activity')
  // Once sent, the row reads the record's own text, from the sample data.
  const row = page.locator('button[data-activity-row]').filter({ hasText: KESTREL_SENT }).first()
  await expect(row).toBeVisible()
  await expect(row).toContainText(/8:00\s*AM/)
  await page.clock.resume()
})

test('S4: Usage shows this month\'s spend and the per-tool dollars as before', async ({ fx, page }) => {
  await start(page, fx)
  await goTo(page, 'Usage')
  await expect(h1(page)).toHaveText('Usage')
  await expect(main(page).getByText('$78.40').first()).toBeVisible()
  await main(page).getByRole('radiogroup', { name: 'Break down by' }).getByRole('radio', { name: 'Tool', exact: true }).click()
  const rows = page.locator('[data-usage-row]')
  await expect(rows.first()).toBeVisible()
  const costs = await rows.evaluateAll(els => els.map(e => Number(e.getAttribute('data-cost') ?? '0')))
  expect(costs.length).toBeGreaterThan(0)
  expect(Math.round(costs.reduce((a, c) => a + c, 0) * 100) / 100).toBe(78.4)
  // Each tool's row reads its own dollars, to the cent.
  for (const [i, cost] of costs.entries()) await expect(rows.nth(i)).toContainText(`$${cost.toFixed(2)}`)
})

test('S5: The demo switches move to Run and to Cap reached, and Reset demo returns to the start', async ({ fx, page }) => {
  await start(page, fx)
  // Hold the page clock, then let half an hour pass: a clock that Reset demo didn't send back would now stamp 8:30 AM.
  const started = (await fx.saved()).demo.demoStartedAt as number
  await page.clock.install({ time: started })
  await page.clock.pauseAt(started + 20_000)
  await page.clock.runFor(30 * 60_000)
  let panel = await switches(page)
  await panel.getByRole('radiogroup', { name: 'Stage' }).getByRole('radio', { name: 'Run', exact: true }).click()
  await panel.getByRole('button', { name: 'Close demo switches' }).click()
  await expect(h1(page)).toContainText('4 handled before you woke up. 3 need you.')
  panel = await switches(page)
  await panel.getByRole('button', { name: 'Cap reached', exact: true }).click()
  await panel.getByRole('button', { name: 'Close demo switches' }).click()
  await expect(page.getByRole('alert')).toContainText('Spending cap reached.')
  panel = await switches(page)
  await panel.getByRole('button', { name: 'Reset demo' }).click()
  await expect(toast(page, 'Demo reset. Every change is cleared.')).toBeVisible()
  await panel.getByRole('button', { name: 'Close demo switches' }).click()
  await expect(page.getByRole('button', { name: 'Demo switches: Act, Normal' })).toBeVisible()
  await expect(h1(page)).toContainText('6 things need you. A fix is drafted for each.')
  await expect(page.getByRole('alert')).toHaveCount(0)
  // The clock is back at the 8:00 AM start: an approval is stamped 8:00 AM, not 8:30.
  await approve(page)
  await page.keyboard.press('Escape')
  await expect(card(page, KESTREL)).toContainText(/8:00\s*AM/)
  await page.clock.resume()
})

test('S6: Library and All chats show their dates as before, and the Library\'s sample files open', async ({ fx, page }) => {
  await start(page, fx)
  await goTo(page, 'Library')
  await expect(h1(page)).toHaveText('All files')
  // Today's file shows Mon, Nov 16 and its time; an older one shows its own day.
  const files = page.getByRole('list', { name: 'Files' }).getByRole('listitem')
  const open = async (name: string) => {
    await files.filter({ hasText: name }).first().click()
    const viewer = page.getByRole('dialog', { name: `File: ${name}` })
    await expect(viewer).toBeVisible()
    return viewer
  }
  let viewer = await open('stuck-orders-over-3-days.csv')
  await expect(viewer).toContainText('Nov 16')
  await expect(viewer).toContainText(/7:43\s*AM/)
  await viewer.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  viewer = await open('kestrel-call-nov-3.m4a')
  await expect(viewer).toContainText('Nov 3')
  await viewer.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // All chats groups by day.
  await (await sidebar(page)).getByRole('button', { name: 'See all' }).click()
  await expect(h1(page)).toHaveText('All chats')
  await expect(main(page).locator('section[aria-label="Yesterday"]')).toBeVisible()
})
