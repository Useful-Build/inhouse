// End-to-end checks for the app as a whole.
// Each test starts from a clean demo state at a given stage and scenario.
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

async function start(page: Page, stage: 'Watch' | 'Act' | 'Run', scenario = 'Normal', hash = '#/today') {
  await page.addInitScript(([s, sc]) => {
    if (sessionStorage.getItem('e2e-seeded')) return
    localStorage.clear()
    localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: s, scenario: sc, ambient: 'Always', animateMark: true }))
    sessionStorage.setItem('e2e-seeded', '1')
  }, [stage, scenario])
  await page.goto('/?demo' + hash)
}

const badge = (page: Page) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Approvals/ })
const card = (page: Page, title: string) => page.getByRole('article').filter({ hasText: title })

test('Act: money drafts need a review, the Kestrel reorder holds 10 s then is final, the restock keeps Undo, counts agree', async ({ page }) => {
  await start(page, 'Act')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('6 things need you. A fix is drafted for each.')
  await expect(badge(page)).toContainText('6')

  // Money: no one-tap approve on the card.
  const kestrel = card(page, 'Ridge 30L Pack runs out in 9 days')
  await expect(kestrel.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0)
  await kestrel.getByRole('button', { name: 'Review' }).click()

  const panel = page.getByRole('dialog')
  await expect(panel).toContainText('Spends money')
  await expect(panel).toContainText('Remembered: Kestrel ships in 14 days')
  await expect(panel).toContainText('Dana Kim usually approves orders over $5,000')
  await page.screenshot({ path: test.info().outputPath('act-panel-kestrel.png') })
  await panel.getByRole('button', { name: 'Approve and send to Kestrel' }).click()

  const toast = page.getByRole('status').filter({ hasText: 'Approved. It goes out in 10 seconds.' })
  await expect(toast).toBeVisible()
  await expect(toast.getByRole('button', { name: 'Undo', exact: true })).toBeVisible()
  await expect(panel).toContainText('Approved: reorder 600 ridge 30l packs'.replace('ridge 30l packs', 'Ridge 30L Packs'))
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('5 left to approve today.')
  await expect(badge(page)).toContainText('5')
  await expect(kestrel).toContainText(/Approved by Sam at \d{1,2}:\d\d\s[AP]M · going out/)
  await page.screenshot({ path: test.info().outputPath('act-hold.png') })

  // After 10 s: sent, final, no Undo anywhere.
  await expect(page.getByRole('status').filter({ hasText: 'Reorder of 600 sent to Kestrel Supply' })).toBeVisible({ timeout: 12_000 })
  await expect(kestrel).not.toContainText('going out')
  await kestrel.click()
  await expect(panel).toContainText('Reorder of 600 sent to Kestrel Supply')
  await expect(panel.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // Low risk: one-tap approve, reversible, Undo stays.
  const returns = card(page, '11 returns are not restocked')
  await returns.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '11 units restocked on Shopify' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('4 left to approve today.')
  await expect(badge(page)).toContainText('4')

  await badge(page).click()
  await expect(page.getByText('Waiting for you')).toBeVisible()
  await expect(page.getByText(/Waiting for you\s*·\s*4/)).toBeVisible()
  const approvedToday = page.getByRole('region', { name: 'Approved today' })
  await expect(approvedToday).toContainText('11 units restocked on Shopify')
  await expect(page.locator('main').getByRole('button', { name: 'Undo', exact: true })).toHaveCount(1)
  await page.screenshot({ path: test.info().outputPath('act-approvals.png'), fullPage: true })

  await page.getByRole('button', { name: 'Notifications' }).click()
  await expect(page.getByText('4 drafts are waiting for your approval.')).toBeVisible()
})

test('Chat: the stuck-orders question always gives the same table and a 6-step, 9.4 s trace', async ({ page }) => {
  await start(page, 'Act')
  await page.getByRole('textbox', { name: 'Ask your Inhouse agent' }).fill('Which orders are stuck over 3 days?')
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-composer]').getByRole('button', { name: 'Stop' })).toBeVisible()
  const chat = page.locator('main')
  // A question from Today starts a chat of its own, so the table shows once. Its answer is the same table the
  // Stuck orders chat holds.
  await expect(chat.getByText('3 orders · $556')).toHaveCount(1, { timeout: 6_000 })
  await expect(chat.getByText('Not picked at ShipBob')).toHaveCount(1)
  await page.screenshot({ path: test.info().outputPath('chat-stuck.png') })

  await chat.getByRole('button', { name: /6 steps/ }).last().click()
  const trace = page.getByRole('dialog', { name: /What your Inhouse agent did/ })
  await expect(trace).toContainText('Which orders are stuck over 3 days?')
  await expect(trace).toContainText('9.4s')
  await expect(trace).not.toContainText(/Haiku|Sonnet|Opus|token/i)
  await page.screenshot({ path: test.info().outputPath('trace-plain.png') })
  await trace.getByRole('radio', { name: 'Technical' }).click()
  await expect(trace).toContainText('Tokens')
  await expect(trace).toContainText('18.2k')
  await trace.getByRole('button', { name: 'Replay', exact: true }).click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: test.info().outputPath('trace-replay.png') })
})

test('Chat: Stop ends a run and says nothing was changed', async ({ page }) => {
  await start(page, 'Act', 'Normal', '#/chats')
  await page.getByRole('textbox', { name: 'Message your Inhouse agent' }).fill('Why did refunds jump this week?')
  await page.keyboard.press('Enter')
  await page.locator('[data-composer]').getByRole('button', { name: 'Stop' }).click()
  await expect(page.getByText('You stopped your Inhouse agent. Nothing was changed.')).toBeVisible()
  await page.waitForTimeout(3000)
  await expect(page.getByText(/Refund requests rose from 14/)).toHaveCount(0)
})

test('Run: 4 handled, 3 need you; the jacket is paused by Inhouse agent with 5 emails waiting; Pause stops routines', async ({ page }) => {
  await start(page, 'Run')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('4 handled before you woke up. 3 need you.')
  await expect(card(page, 'Trail Shell Jacket (M, Olive) is oversold by 5')).toContainText('Paused · emails wait for you')
  await card(page, 'Trail Shell Jacket (M, Olive) is oversold by 5').click()
  const panel = page.getByRole('dialog')
  await expect(panel).toContainText('Email 5 customers about the delay')
  await expect(panel).toContainText('Your Inhouse agent already paused the variant at 6:04 AM')
  await page.keyboard.press('Escape')
  await page.screenshot({ path: test.info().outputPath('run-today.png'), fullPage: true })

  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(page.getByText('Inhouse agent is paused', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible()
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Routines' }).click()
  await expect(page.getByText('Paused', { exact: true }).first()).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('run-paused-routines.png'), fullPage: true })
})

test('Tool disconnected: banner, Gorgias question fails with Try again', async ({ page }) => {
  await start(page, 'Act', 'Tool disconnected')
  await expect(page.getByRole('alert')).toContainText('Gorgias is disconnected.')
  await page.getByRole('textbox', { name: 'Ask your Inhouse agent' }).fill('What are customers saying in Gorgias tickets?')
  await page.keyboard.press('Enter')
  await expect(page.getByText(/I couldn't read Gorgias/)).toBeVisible({ timeout: 5_000 })
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('disconnected-error.png') })
})

test('Usage totals agree in every breakdown', async ({ page }) => {
  await start(page, 'Act', 'Normal', '#/usage')
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
