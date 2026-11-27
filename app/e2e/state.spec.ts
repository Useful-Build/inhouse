// State that has to survive or reverse: the 10 s send hold across a reload, Undo, Reset, and the Run Undo and Pause paths.
import { expect, fxFor, test, type Fx } from './support/fx.js'
import type { Page } from '@playwright/test'
import { everything } from './page-text.js'

async function start(page: Page, fx: Fx, stage: 'Watch' | 'Act' | 'Run', scenario = 'Normal', hash = '#/today', fakeClock = false) {
  // The 10 s hold and the toasts run on app timers: a test that waits for them installs the clock first (time keeps flowing) and adds app time with runFor.
  if (fakeClock) await page.clock.install()
  await fx.seed({ stage, scenario, demo: { ambient: 'Always', animateMark: true } })
  await page.goto('/?demo' + hash)
}

const badge = (page: Page) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Approvals/ })
/** Stage 1 M3-U: the demo's three agent cards (two batches and a teammate's refund) wait on Sam too, beside the drafts. */
const ASKS = 3
const card = (page: Page, title: string) => page.getByRole('article').filter({ hasText: title })
const KESTREL = 'Ridge 30L Pack runs out in 9 days'
const sentToast = (page: Page) => page.getByRole('status').filter({ hasText: 'Reorder of 600 sent to Kestrel Supply' })

/** Approve the Kestrel reorder from the panel and close the panel. Returns the "goes out in 10 seconds" toast. */
async function approveKestrel(page: Page) {
  await card(page, KESTREL).getByRole('button', { name: 'Review' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Approve and send to Kestrel' }).click()
  const toast = page.getByRole('status').filter({ hasText: 'Approved. It goes out in 10 seconds.' })
  await expect(toast).toBeVisible()
  await page.keyboard.press('Escape')
  return toast
}

test('Act: a reload during the 10 s hold still sends the Kestrel reorder, and Undo is gone', async ({ fx, page }) => {
  await start(page, fx, 'Act', 'Normal', '#/today', true)
  await approveKestrel(page)
  await page.clock.runFor(3000)
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('5 left to approve today.')
  await expect(card(page, KESTREL)).toContainText('going out')

  const sent = sentToast(page)
  await page.clock.fastForward(10_000)
  await expect(sent).toBeVisible()
  await expect(sent.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0)
  await expect(card(page, KESTREL)).not.toContainText('going out')
  await card(page, KESTREL).click()
  const panel = page.getByRole('dialog')
  await expect(panel).toContainText('Reorder of 600 sent to Kestrel Supply')
  await expect(panel.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath('state-reload-sent.png') })
})

test('Act: Undo in the toast during the hold cancels the send', async ({ fx, page }) => {
  await start(page, fx, 'Act', 'Normal', '#/today', true)
  const toast = await approveKestrel(page)
  await expect(badge(page)).toContainText(String(5 + ASKS))
  await toast.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(badge(page)).toContainText(String(6 + ASKS))
  await expect(card(page, KESTREL).getByRole('button', { name: 'Review' })).toBeVisible()

  await page.clock.runFor(11_000)
  await expect(badge(page)).toContainText(String(6 + ASKS))
  await expect(card(page, KESTREL).getByRole('button', { name: 'Review' })).toBeVisible()
  await expect(sentToast(page)).toHaveCount(0)
  await expect(card(page, KESTREL)).not.toContainText('Approved by Sam')
})

test('Run: Undo on a handled card sends it back to you, and the toast Undo restores it', async ({ fx, page }) => {
  await start(page, fx, 'Run')
  const heading = page.getByRole('heading', { level: 1 })
  await expect(heading).toContainText('4 handled today. 3 need you.')

  await card(page, '11 returns are not restocked').getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(heading).toContainText('3 handled today. 4 need you.')
  await expect(card(page, '11 returns are not restocked')).toContainText('Undone · back to you')
  await page.screenshot({ path: test.info().outputPath('state-run-undone.png') })

  const toast = page.getByRole('status').filter({ hasText: 'Undone:' })
  await expect(toast).toBeVisible()
  await toast.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(heading).toContainText('4 handled today. 3 need you.')
  await expect(card(page, '11 returns are not restocked')).toContainText('Handled by Inhouse agent')
})

test('Run: Pause, then Undo in the toast, puts Inhouse agent back to running', async ({ fx, page }) => {
  await start(page, fx, 'Run')
  await expect(page.getByRole('status', { name: 'Inhouse agent is running', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(page.getByRole('status', { name: 'Inhouse agent is paused', exact: true })).toBeVisible()

  const toast = page.getByRole('status').filter({ hasText: 'Inhouse agent is paused. Chats, routines and jobs are stopped.' })
  await expect(toast).toBeVisible()
  await toast.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(page.getByRole('status', { name: 'Inhouse agent is running', exact: true })).toBeVisible()
  await expect(page.getByRole('status', { name: 'Inhouse agent is paused', exact: true })).toHaveCount(0)
})

test('Act: Reset demo during the hold clears the approval and nothing is sent', async ({ fx, page }) => {
  await start(page, fx, 'Act', 'Normal', '#/today', true)
  await approveKestrel(page)
  await expect(badge(page)).toContainText(String(5 + ASKS))

  await page.getByRole('button', { name: /Demo switches/ }).click()
  await page.getByRole('button', { name: 'Reset demo', exact: true }).click()
  await expect(badge(page)).toContainText(String(6 + ASKS))
  await expect(card(page, KESTREL).getByRole('button', { name: 'Review' })).toBeVisible()

  await page.clock.runFor(11_000)
  await expect(badge(page)).toContainText(String(6 + ASKS))
  await expect(sentToast(page)).toHaveCount(0)
})

test('Act: two tabs, closing the one that started the hold still sends the reorder, and the other tab says so', async ({ fx, page, context }) => {
  // Only page A seeds storage. Page B joins the same browser context and must not clear it.
  // The clock belongs to the context, so tab B shares it with tab A.
  await start(page, fx, 'Act', 'Normal', '#/today', true)
  await approveKestrel(page)

  const other = await context.newPage()
  await other.goto('/?demo#/today')
  await expect(other.getByRole('heading', { level: 1 })).toContainText('5 left to approve today.')
  await expect(card(other, KESTREL)).toContainText('going out')

  await page.clock.runFor(2000)
  await page.close()

  const sent = sentToast(other)
  await other.clock.fastForward(10_000)
  await expect(sent).toBeVisible()
  await expect(card(other, KESTREL)).not.toContainText('going out')
  await other.screenshot({ path: test.info().outputPath('state-two-tabs-sent.png') })
})

test('Deep links: an unknown page lands on Today and an unknown tool on the Tools list, with no extra history entries', async ({ fx, page, context, baseURL }) => {
  const historyLength = (p: Page) => p.evaluate(() => history.length)
  const hash = (p: Page) => p.evaluate(() => location.hash)

  // Cold loads of a stale link end with the same history as a clean link.
  await start(page, fx, 'Act', 'Normal', '#/today')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('6 things need you.')
  const reference = await context.newPage()
  await start(reference, fxFor(reference, baseURL), 'Act', 'Normal', '#/today')
  await expect(reference.getByRole('heading', { level: 1 })).toContainText('6 things need you.')
  const clean = await historyLength(reference)

  const nope = await context.newPage()
  await start(nope, fxFor(nope, baseURL), 'Act', 'Normal', '#/nope')
  await expect(nope.getByRole('heading', { level: 1 })).toContainText('6 things need you.')
  await expect.poll(() => hash(nope)).toBe('#/today')
  expect(await historyLength(nope)).toBe(clean)

  const bogus = await context.newPage()
  await start(bogus, fxFor(bogus, baseURL), 'Act', 'Normal', '#/tools/bogus')
  await expect(bogus.getByRole('heading', { level: 1 })).toHaveText('Tools')
  await expect.poll(() => hash(bogus)).toBe('#/tools')
  expect(await historyLength(bogus)).toBe(clean)

  // Typing a stale link in the running app: the move itself is one entry, tidying it adds none.
  const before = await historyLength(page)
  await page.evaluate(() => { location.hash = '#/nope' })
  await expect.poll(() => hash(page)).toBe('#/today')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('6 things need you.')
  expect(await historyLength(page)).toBe(before + 1)

  await page.evaluate(() => { location.hash = '#/tools/bogus' })
  await expect.poll(() => hash(page)).toBe('#/tools')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tools')
  expect(await historyLength(page)).toBe(before + 2)
})

test('Chats: New chat right after asking leaves the new chat empty, and the old answer never shows up', async ({ fx, page }) => {
  await start(page, fx, 'Act', 'Normal', '#/today', true)
  await page.getByRole('textbox', { name: 'Ask Inhouse' }).fill('Why did refunds jump this week?')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'New chat' }).click()

  await page.clock.runFor(3000)
  await expect(page.getByRole('heading', { name: 'What should we look into?' })).toBeVisible()
  await expect(page.getByText('Refund requests rose')).toHaveCount(0)
  // Only the suggestion chip may carry the question in the chat; the old user bubble must be gone.
  // (The sidebar lists the first chat under Recent chats, which is right.)
  await expect(page.locator('main').getByText('Why did refunds jump this week?')).toHaveCount(1)
  await expect(page.locator('main').getByRole('button', { name: 'Why did refunds jump this week?' })).toHaveCount(1)
  await expect(page.getByRole('status').filter({ hasText: 'Reading' })).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath('state-new-chat-empty.png') })
})

test('Saved storage holding old values (persona name, morning email settings, removed message ids) loads cleanly', async ({ page, fx }) => {
  const problems: string[] = []
  page.on('console', m => { if (m.type() === 'error' || (m.type() === 'warning' && m.text().startsWith('Inhouse demo'))) problems.push(`${m.type()}: ${m.text()}`) })
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`))
  // The saved state the app reads now, holding values earlier versions saved.
  await fx.seedSaved({ stage: 'Run', demo: { ambient: 'When Ava works', animateMark: true } }, {
    approved: {}, sent: {}, undone: {}, edits: {}, paused: null, requestedTools: {}, requestedSkills: {}, toolPaused: {}, forgot: {},
    toggles: { 'n:email': true, 'n:weekend': false, 'n:slack': true },
    settings: { 'n:email': 'Email and Slack', 'n:at': '07:00', 'n:weekend': 'Off', 't:name': 'Ava', 't:signs': 'The Northline team' },
    routinesExtra: [], skillsExtra: [], teamRequests: [], readNotices: {},
    libraryDeleted: { 'm-10': true, 'm-11': true, 'm-12': true, 'm-13': true, 'm-14': true, 'm-17': true },
    setAside: {}, routinesDeleted: {}, routineRuns: [], chatTitles: {}, chatPinned: {}, chatDeleted: {},
  })
  await page.goto('/?demo#/today')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('handled today')

  // The old dot sweep value maps to the renamed option instead of falling back to Always.
  await page.getByRole('button', { name: /^Demo switches:/ }).click()
  await expect(page.getByRole('radiogroup', { name: 'Dot sweep' }).getByRole('radio', { name: 'When working' })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('button', { name: 'Close demo switches' }).click()

  // Ids that no longer exist change nothing: every file is still there.
  await page.evaluate(() => { location.hash = '#/library' })
  await expect(page.getByRole('radio', { name: /^All 38/ })).toBeVisible()

  for (const [hash, heading] of [
    ['#/settings/you-general', 'General'], ['#/settings/you-notif', 'Notifications'], ['#/settings/team-agent', 'Inhouse agent'],
    ['#/settings/team-limits', 'Run limits'], ['#/activity', 'Activity'], ['#/routines', 'Routines'],
  ]) {
    await page.evaluate(h => { location.hash = h }, hash)
    await expect(page.getByRole('heading', { level: 1, name: heading, exact: true }), `${hash} did not render`).toBeVisible()
    expect(await everything(page), hash).not.toMatch(/\bAva\b|morning email/i)
  }
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Routines' })).toBeVisible()
  // It was read, not ignored: the old settings are still in the saved state.
  expect((await fx.saved()).demo.settings?.['n:at']).toBe('07:00')
  expect(problems, 'console errors on a start from the old values').toEqual([])
})
