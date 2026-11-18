// PR 4, Today, Approvals and the review panel, at 1440: no card cuts a word at Watch, Act or Run; a draft with no text of
// its own takes a note in the panel, is approved there and keeps the note through Undo; Approve all low-risk comes back with
// one Undo from the toast. The 390 px twin is today-approvals-phone.spec.ts.
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { expectNothingCut, start, STAGES } from './today-approvals-helpers.js'

const shot = async (page: Page, name: string) => {
  await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)))
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true })
}
const waiting = (page: Page) => page.getByRole('heading', { level: 2, name: /^Waiting for you/ })
const toast = (page: Page, text: string | RegExp) => page.locator('[data-toast]').filter({ hasText: text })
const draft = (page: Page, title: string) => page.locator('[data-slot=card]').filter({ has: page.getByRole('heading', { level: 2, name: title, exact: true }) })
const RETURNS = 'Restock 11 units on Shopify'

for (const stage of STAGES) {
  test(`1440: at ${stage}, no card on Today or Approvals cuts any text`, async ({ page }) => {
    await start(page, stage, '#/today')
    await expectNothingCut(page, stage)
    await shot(page, `approvals-${stage.toLowerCase()}-1440`)
  })
}

test('A draft with no text: Edit opens the panel on a note field, the note rides through approve and Undo', async ({ page }) => {
  await start(page, 'Act', '#/approvals')
  await expect(waiting(page)).toHaveText(/·\s6$/)
  // The restock has lines but no text of its own; Edit is in the card's "···" menu and always opens the panel.
  const card = draft(page, RETURNS)
  await expect(card.getByRole('button', { name: 'Approve and restock' })).toBeVisible()
  await expect(card.getByText('Low risk', { exact: true })).toBeVisible()
  await card.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menu', { name: 'Draft actions' }).getByRole('menuitem', { name: 'Edit', exact: true }).click()
  const panel = page.getByRole('dialog')
  const note = panel.getByRole('textbox', { name: 'Your note' })
  await expect(note).toBeVisible()
  await expect(panel).toContainText('Ridge 30L · Olive')
  await note.fill('Olive units first, the rest after the count.')
  await shot(page, 'panel-note-1440')

  // The actions sit on one row above the ask bar, all inside the panel's box.
  const actions = await Promise.all(['Approve and restock', 'Done', "Don't send"].map(n => panel.getByRole('button', { name: n, exact: true }).boundingBox()))
  const ask = await panel.getByRole('button', { name: 'Ask about this…' }).boundingBox()
  const box = await panel.boundingBox()
  for (const b of actions) expect(b).not.toBeNull()
  const tops = actions.map(b => Math.round(b!.y))
  expect(Math.max(...tops) - Math.min(...tops), 'the three actions share one row').toBeLessThanOrEqual(4)
  expect(actions[0]!.y + actions[0]!.height, 'actions end above the ask bar').toBeLessThanOrEqual(ask!.y)
  expect(ask!.y + ask!.height, 'the ask bar stays inside the panel').toBeLessThanOrEqual(box!.y + box!.height)

  await panel.getByRole('button', { name: 'Approve and restock', exact: true }).click()
  await expect(panel).toContainText('11 units restocked on Shopify')
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(waiting(page)).toHaveText(/·\s5$/)
  const approved = page.getByRole('region', { name: 'Approved today' })
  await expect(approved).toContainText('11 units restocked on Shopify')

  // Undo brings the draft back with the note still on it.
  await approved.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(waiting(page)).toHaveText(/·\s6$/)
  await expect(draft(page, RETURNS)).toContainText('Olive units first, the rest after the count.')
  await expect(draft(page, RETURNS)).toContainText('Your note')
})

test('Approve all low-risk approves three drafts, and one Undo in the toast takes them all back', async ({ page }) => {
  await start(page, 'Act', '#/approvals')
  await expect(waiting(page)).toHaveText(/·\s6$/)
  await page.getByRole('button', { name: 'Approve all low-risk' }).click()
  await expect(waiting(page)).toHaveText(/·\s3$/)
  const approved = page.getByRole('region', { name: 'Approved today' })
  await expect(approved.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(3)
  await expect(page.getByRole('button', { name: 'Approve all low-risk' })).toHaveCount(0)
  // The sensitive three stay: each one's primary action is Review.
  await expect(page.getByRole('main').getByRole('button', { name: 'Review', exact: true })).toHaveCount(3)
  await shot(page, 'approved-all-low-risk-1440')
  await toast(page, 'Approved 3 drafts').getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(waiting(page)).toHaveText(/·\s6$/)
  await expect(approved).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Approve all low-risk' })).toBeVisible()
})

test('Today: the whole card opens the panel from one real button, and the "···" menu does not', async ({ page }) => {
  await start(page, 'Act', '#/today')
  const card = page.getByRole('article', { name: 'Ridge 30L Pack runs out in 9 days' })
  // The title is a real button; the card has no click handler of its own.
  await card.getByRole('button', { name: 'Ridge 30L Pack runs out in 9 days' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toContainText('What your Inhouse agent found')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // A click on the card's blank area lands on the title's stretched hit area and opens it too.
  await card.click({ position: { x: 200, y: 100 } })
  await expect(page.getByRole('dialog')).toContainText('What your Inhouse agent found')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await card.getByRole('button', { name: 'More' }).click()
  await expect(page.getByRole('menu', { name: 'Card actions' })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
