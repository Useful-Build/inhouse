// PR 4 at 390 px: no card cuts a word (the agent's action cards too); Today has no sort and Approvals' header stays on one line with
// Approve all low-risk alone; each draft is its approve action (or Review draft) plus "···"; an approved row's time and Undo wrap under its text.
import { expect, test } from './csp.js'
import type { Page } from '@playwright/test'
import { expectNothingCut, start } from './today-approvals-helpers.js'

const shot = async (page: Page, name: string) => {
  await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.timeline instanceof DocumentTimeline && a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)))
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true })
}
const waiting = (page: Page) => page.getByRole('heading', { level: 2, name: /^Waiting for you/ })
const draft = (page: Page, title: string) => page.locator('[data-slot=card]').filter({ has: page.getByRole('heading', { level: 2, name: title, exact: true }) })

// The demo has no stages since decision A13: one view, with the agent's action cards beside the drafts.
test('Phone 390: no card on Today or Approvals cuts any text', async ({ page }) => {
  await start(page, '#/today')
  await expectNothingCut(page)
  await shot(page, 'approvals-390')
})

test('Phone 390: Today has no sort and no fixed card height; Approvals has one header line, Approve plus "···", and approved rows that reflow', async ({ page }) => {
  await start(page, '#/today')
  await expect(page.getByRole('article').first()).toBeVisible()
  await expect(page.getByRole('combobox', { name: /^Sort cards/ })).toHaveCount(0)
  // No fixed card height: the cards have no minimum height at all.
  const minHeights = await page.getByRole('article').evaluateAll(els => els.map(e => getComputedStyle(e).minHeight))
  expect(minHeights.every(h => h === '0px' || h === 'auto'), `min-height of each card: ${minHeights}`).toBe(true)
  // The card has no click handler of its own: its title is the one button that opens it.
  expect(await page.getByRole('article').first().evaluate(e => e.onclick)).toBeNull()

  await page.getByRole('button', { name: 'Menu' }).click()
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: /Approvals/ }).click()
  await expect(waiting(page)).toHaveText(/·\s6$/)
  await expect(page.getByRole('combobox', { name: /^Sort drafts/ })).toHaveCount(0)
  // The header is one line: the title and Approve all low-risk share a row.
  const title = await waiting(page).boundingBox()
  const all = await page.getByRole('button', { name: 'Approve all low-risk' }).boundingBox()
  expect(all!.y, 'the action starts on the title line').toBeLessThan(title!.y + title!.height)

  // A card's footer: the primary action and "···" share a row.
  const stuck = draft(page, "Ask ShipBob why #4821 hasn't shipped")
  const primary = await stuck.getByRole('button', { name: 'Approve and send to ShipBob' }).boundingBox()
  const more = await stuck.getByRole('button', { name: /^More actions for/ }).boundingBox()
  expect(Math.abs(primary!.y - more!.y)).toBeLessThanOrEqual(8)
  await stuck.getByRole('button', { name: 'Approve and send to ShipBob' }).click()

  // The approved row keeps its text on its own line, with the time under it and nothing running past the card's edge.
  const approved = page.getByRole('region', { name: 'Approved today' })
  await expect(approved).toBeVisible()
  const row = approved.locator('div.border-b').first()
  expect(await row.evaluate(e => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1)
  const text = await row.locator('span.basis-40').boundingBox()
  const meta = await row.getByText(/Sam/).first().boundingBox()
  expect(meta!.y, 'the time wraps under the text').toBeGreaterThan(text!.y)
  await shot(page, 'approvals-approved-row-390')
})

test('Phone 390: the review panel gives its main action a full-width row of its own, on one line, with More below', async ({ page }) => {
  await start(page, '#/today')
  await page.getByRole('article', { name: 'Ridge 30L Pack runs out in 9 days' }).getByRole('button', { name: 'Review' }).click()
  const panel = page.getByRole('dialog')
  const primary = await panel.getByRole('button', { name: /^Approve and/ }).boundingBox()
  const dont = await panel.getByRole('button', { name: 'More', exact: true }).boundingBox()
  const box = await panel.boundingBox()
  // The main action is 46px tall: one line of its label, where two would pass 60.
  expect(primary!.height, 'the main label is on one line').toBeLessThanOrEqual(48)
  expect(await panel.getByRole('button', { name: /^Approve and/ }).evaluate(e => e.scrollWidth <= e.clientWidth), 'the label fits its button').toBe(true)
  expect(primary!.width, 'the main action spans the footer').toBeGreaterThan(box!.width - 60)
  expect(dont!.y, "More sits below the main action").toBeGreaterThan(primary!.y + primary!.height - 1)
  expect(dont!.height, "More is a full tap target").toBeGreaterThanOrEqual(44)
  await shot(page, 'panel-actions-390')
})
