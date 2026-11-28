// End-to-end checks for the app as a whole.
// Each test starts from a clean demo state in a given scenario. The demo has no stages (decision A13), as the product.
import { expect, fxFor, test } from './support/fx.js'
import type { Page } from '@playwright/test'
import { atRest } from './states.js'
import { openTraceFrom } from './support/steps.js'

async function start(page: Page, scenario = 'Normal', hash = '#/today') {
  await fxFor(page, undefined).seed({ scenario, demo: { ambient: 'Always', animateMark: true } })
  await page.goto('/?demo' + hash)
}

const badge = (page: Page) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Approvals/ })
/**
 * The demo's agent cards wait on Sam too, beside the drafts: two batches and a teammate's refund (Stage 1 M3-U), two ask
 * cards and one that needs a check (the demo catch-up's PR 1), and the two questions that wait (PR 3). A teammate's own ask isn't Sam's to answer.
 */
const ASKS = 8
const card = (page: Page, title: string) => page.getByRole('article').filter({ hasText: title })

// #726: the demo shows only what the product does. The Kestrel reorder is a finding (no draft: no tool sends a
// purchase order), the payout post goes to #ops-alerts in Slack (10 s hold, then final), the restock keeps Undo.
test('Today: a finding offers no approval, the Slack post holds 10 s then is final, the restock keeps Undo, counts agree', async ({ page }) => {
  await start(page)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('3 left to approve today.')
  await expect(badge(page)).toContainText(String(3 + ASKS))

  // A finding: what Inhouse noticed and its suggestion, with no Approve on the card or in its window.
  const kestrel = card(page, 'Ridge 30L Pack runs out in 9 days')
  await expect(kestrel).toContainText('Suggested: reorder 600 from Kestrel Supply today')
  await expect(kestrel.getByRole('button', { name: /^Approve/ })).toHaveCount(0)
  await kestrel.click({ position: { x: 12, y: 12 } })
  const panel = page.getByRole('dialog')
  await expect(panel).toContainText('Your Inhouse agent suggests')
  await expect(panel.getByRole('button', { name: /^Approve/ })).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath('today-finding-panel.png') })
  await page.keyboard.press('Escape')

  // The payout post: one tap, a 10 s hold with Undo, then final.
  const payout = card(page, 'Amazon paid out $1,240 less than expected')
  await expect(payout).toContainText('Post to #ops-alerts in Slack')
  await payout.getByRole('button', { name: 'Approve and post', exact: true }).click()
  const toast = page.getByRole('status').filter({ hasText: 'Approved. It goes out in 10 seconds.' })
  await expect(toast).toBeVisible()
  await expect(toast.getByRole('button', { name: 'Undo', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('2 left to approve today.')
  await expect(badge(page)).toContainText(String(2 + ASKS))
  await expect(payout).toContainText(/Approved by Sam at \d{1,2}:\d\d\s[AP]M · going out/)
  await page.screenshot({ path: test.info().outputPath('today-hold.png') })
  await expect(page.getByRole('status').filter({ hasText: 'Posted to #ops-alerts for Dana' })).toBeVisible({ timeout: 12_000 })
  await expect(payout).not.toContainText('going out')

  // Low risk and reversible: one tap, Undo stays.
  const returns = card(page, '11 returns are not restocked')
  await returns.getByRole('button', { name: 'Approve and restock', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '11 units restocked on Shopify' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('1 left to approve today.')
  await expect(badge(page)).toContainText(String(1 + ASKS))

  await badge(page).click()
  await expect(page.getByText(/Waiting for you\s*·\s*1/)).toBeVisible()
  const approvedToday = page.getByRole('region', { name: 'Approved today' })
  await expect(approvedToday).toContainText('11 units restocked on Shopify')
  await expect(page.locator('main').getByRole('button', { name: 'Undo', exact: true })).toHaveCount(1)
  await page.screenshot({ path: test.info().outputPath('act-approvals.png'), fullPage: true })

  await page.getByRole('button', { name: /^Notifications/ }).click()
  await expect(page.getByText('1 draft is waiting for your approval.')).toBeVisible()
})

test('Chat: the stuck-orders question always gives the same table and a 6-step, 9.4 s trace', async ({ page }) => {
  await start(page)
  await page.getByRole('textbox', { name: 'Ask Inhouse' }).fill('Which orders are stuck over 3 days?')
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-composer]').getByRole('button', { name: 'Stop' })).toBeVisible()
  const chat = page.locator('main')
  // A question from Today starts a chat of its own, so the table shows once. Its answer is the same table the
  // Stuck orders chat holds.
  await expect(chat.getByText('3 orders · $556')).toHaveCount(1, { timeout: 6_000 })
  await expect(chat.getByText('Not picked at ShipBob')).toHaveCount(1)
  await page.screenshot({ path: test.info().outputPath('chat-stuck.png') })

  await openTraceFrom(chat.getByRole('button', { name: /6 steps/ }).last())
  const trace = page.getByRole('dialog', { name: /What your Inhouse agent did/ })
  await expect(trace).toContainText('Which orders are stuck over 3 days?')
  await expect(trace).toContainText('9.4s')
  await expect(trace).not.toContainText(/Haiku|Sonnet|Opus|token/i)
  await page.screenshot({ path: test.info().outputPath('trace-plain.png') })
  await trace.getByRole('radio', { name: 'Technical' }).click()
  await expect(trace).toContainText('Tokens')
  await expect(trace).toContainText('18.2k')
  await trace.getByRole('button', { name: 'Replay', exact: true }).click()
  await atRest(page)
  await page.screenshot({ path: test.info().outputPath('trace-replay.png') })
})

test('Chat: Stop ends a run and says nothing was changed', async ({ page }) => {
  await page.clock.install() // time keeps flowing; runFor adds app time on top, so no real sleep
  await start(page, 'Normal', '#/chats')
  await page.getByRole('textbox', { name: 'Message Inhouse' }).fill('Why did refunds jump this week?')
  await page.keyboard.press('Enter')
  await page.locator('[data-composer]').getByRole('button', { name: 'Stop' }).click()
  await expect(page.getByText('You stopped your Inhouse agent. Nothing was changed.')).toBeVisible()
  await page.clock.runFor(30_000)
  await expect(page.getByText(/Refund requests rose from 14/)).toHaveCount(0)
})

// The demo has no Run stage since decision A13: what the agent handled by itself in Run is gone from it, and Pause is
// checked from the one view there is, where it lives on the Spending cap page (the top bar shows Resume once paused).
test('Pause stops routines', async ({ page }) => {
  await start(page, 'Normal', '#/settings/team-spend')
  await page.locator('main').getByRole('button', { name: 'Pause Inhouse agent', exact: true }).click()
  await expect(page.getByRole('status', { name: 'Inhouse agent is paused', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible()
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Routines' }).click()
  // On the Routines page itself: the top bar's status also reads "Paused" now.
  await expect(page.getByRole('main').getByText('Paused', { exact: true }).first()).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('paused-routines.png'), fullPage: true })
})

test('Tool disconnected: banner, Gorgias question fails with Try again', async ({ page }) => {
  await start(page, 'Tool disconnected')
  await expect(page.getByRole('alert')).toContainText('Gorgias is disconnected.')
  await page.getByRole('textbox', { name: 'Ask Inhouse' }).fill('What are customers saying in Gorgias tickets?')
  await page.keyboard.press('Enter')
  await expect(page.getByText(/I couldn't read Gorgias/)).toBeVisible({ timeout: 5_000 })
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('disconnected-error.png') })
})

test('Usage totals agree in every breakdown', async ({ page }) => {
  await start(page, 'Normal', '#/usage')
  await expect(page.getByText('$78.40').first()).toBeVisible()
  for (const tab of ['Person', 'Job', 'Model', 'Tool']) {
    await page.getByRole('radiogroup', { name: 'Break down by' }).getByRole('radio', { name: tab, exact: true }).click()
    const rows = await page.locator('[data-usage-row]').evaluateAll(els => els.map(e => ({
      cost: Number((e.getAttribute('data-cost') ?? '0')), conv: Number(e.getAttribute('data-conv') ?? '0'),
    })))
    expect(rows.length).toBeGreaterThan(0)
    expect(Math.round(rows.reduce((a, r) => a + r.cost, 0) * 100) / 100).toBe(78.4)
    expect(rows.reduce((a, r) => a + r.conv, 0)).toBe(412)
  }
})
