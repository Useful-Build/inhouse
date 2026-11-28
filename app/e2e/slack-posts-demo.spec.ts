// Today's two Slack posts (the payout, the stuck order) follow the product's Slack post card, in the browser (the unit
// rules are in src/agent/mock.asking.test.ts and mock-actions.test.ts). It would fail if:
//  - a Slack post's review window offered Edit (the product's card has none), or a Shopify draft lost it;
//  - "Approve and post" was taken while the agent is paused (it must say so and send nothing), or not taken again after Resume;
//  - a Pause in the post's hold left it to go out, or didn't put it back on Approvals with the server's words and an
//    "Approval sent back" notice in the bell.
import type { Page } from '@playwright/test'
import { expect, fxFor, test } from './support/fx.js'

const STUCK = 'Order #4821 is stuck for 4 days'
const RETURNS = '11 returns are not restocked'
const LAPSED = 'The agent was paused, so this needs your OK again.'

async function start(page: Page) {
  await page.clock.install()
  await fxFor(page, undefined).seed({ scenario: 'Normal' })
  await page.goto('/?demo#/today')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('left to approve today')
}
const go = (page: Page, hash: string) => page.evaluate(h => { location.hash = h }, hash)
const card = (page: Page, title: string) => page.getByRole('article', { name: title })
const panel = (page: Page) => page.getByRole('dialog')
const toast = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text })
/** Pause lives on the Spending cap page, as the asking spec uses it. */
async function pause(page: Page) {
  await go(page, '#/settings/team-spend')
  await page.locator('main').getByRole('button', { name: 'Pause Inhouse agent', exact: true }).click()
  await expect(page.getByRole('status', { name: 'Inhouse agent is paused', exact: true })).toBeVisible()
}

test("A Slack post's review window has no Edit; a Shopify draft keeps it", async ({ page }) => {
  await start(page)
  await card(page, STUCK).click({ position: { x: 12, y: 12 } })
  await expect(panel(page).getByRole('button', { name: 'Approve and post', exact: true })).toBeVisible()
  await expect(panel(page).getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(panel(page)).toHaveCount(0)
  await card(page, RETURNS).click({ position: { x: 12, y: 12 } })
  await expect(panel(page).getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
})

test('No approval of a Slack post while the agent is paused: it says so and sends nothing; Resume takes it', async ({ page }) => {
  await start(page)
  await pause(page)
  await go(page, '#/today')
  await card(page, STUCK).click({ position: { x: 12, y: 12 } })
  await panel(page).getByRole('button', { name: 'Approve and post', exact: true }).click()
  await expect(panel(page).getByRole('alert')).toContainText("It wasn't approved, and nothing went out. The agent is paused.")
  await page.clock.runFor(20_000)
  await expect(toast(page, 'goes out in 10 seconds')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(panel(page)).toHaveCount(0)
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await card(page, STUCK).click({ position: { x: 12, y: 12 } })
  await panel(page).getByRole('button', { name: 'Approve and post', exact: true }).click()
  await expect(toast(page, 'Approved. It goes out in 10 seconds.')).toBeVisible()
})

test('A Pause in the hold of a Slack post puts it back on Approvals with the server words and a bell notice; it never goes out', async ({ page }) => {
  await start(page)
  await card(page, STUCK).click({ position: { x: 12, y: 12 } })
  await panel(page).getByRole('button', { name: 'Approve and post', exact: true }).click()
  await expect(toast(page, 'Approved. It goes out in 10 seconds.')).toBeVisible()
  await pause(page)
  await go(page, '#/approvals')
  await expect(page.locator('main')).toContainText(LAPSED)
  await page.clock.runFor(20_000)
  await expect(page.locator('main')).toContainText(LAPSED)
  await expect(page.getByRole('region', { name: 'Approved today' })).toHaveCount(0)
  await page.getByRole('button', { name: /^Notifications/ }).click()
  await expect(page.getByRole('dialog', { name: 'Notifications' }).getByRole('button', { name: /^Approval sent back/ })).toContainText('Unread')
})
