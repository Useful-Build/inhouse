// PR 4, Today, Approvals and the review panel, at 1440: no card cuts a word (the agent's action cards too); a draft with no text of
// its own takes a note in the panel, is approved there and keeps the note through Undo; Approve all low-risk comes back with
// one Undo from the toast. The 390 px twin is today-approvals-phone.spec.ts.
import { expect, test } from './csp.js'
import type { Page } from '@playwright/test'
import { cutText, expectNothingCut, start } from './today-approvals-helpers.js'

const shot = async (page: Page, name: string) => {
  await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.timeline instanceof DocumentTimeline && a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)))
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true })
}
const waiting = (page: Page) => page.getByRole('heading', { level: 2, name: /^Waiting for you/ })
const toast = (page: Page, text: string | RegExp) => page.locator('[data-toast]').filter({ hasText: text })
const draft = (page: Page, title: string) => page.locator('[data-slot=card]').filter({ has: page.getByRole('heading', { level: 2, name: title, exact: true }) })
const RETURNS = 'Restock 11 units on Shopify'

// The demo has no stages since decision A13: one view, with the agent's action cards beside the drafts.
test('1440: no card on Today or Approvals cuts any text', async ({ page }) => {
  await start(page, '#/today')
  await expectNothingCut(page)
  await shot(page, 'approvals-1440')
})

test('A draft with no text: Edit opens the panel on a note field, the note rides through approve and Undo', async ({ page }) => {
  await start(page, '#/approvals')
  await expect(waiting(page)).toHaveText(/·\s6$/)
  // The restock has lines but no text of its own; Edit is in the card's "···" menu and always opens the panel.
  const card = draft(page, RETURNS)
  await expect(card.getByRole('button', { name: 'Approve and restock' })).toBeVisible()
  await expect(card.getByText('Low risk', { exact: true })).toBeVisible()
  await card.getByRole('button', { name: `More actions for ${RETURNS}` }).click()
  await page.getByRole('menu', { name: 'Draft actions' }).getByRole('menuitem', { name: 'Edit', exact: true }).click()
  const panel = page.getByRole('dialog')
  const note = panel.getByRole('textbox', { name: 'Your note' })
  await expect(note).toBeVisible()
  await expect(panel).toContainText('Ridge 30L · Olive')
  await note.fill('Olive units first, the rest after the count.')
  await shot(page, 'panel-note-1440')

  // Done (Edit while not editing) sits in the draft's own header; "1 of 6" and Close sit on the window's top line, above the title.
  const done = await panel.getByRole('article', { name: 'Shopify change draft' }).getByRole('button', { name: 'Done', exact: true }).boundingBox()
  const close = await panel.getByRole('button', { name: 'Close', exact: true }).boundingBox()
  const title = await panel.getByRole('heading', { name: '11 returns are not restocked' }).boundingBox()
  expect(done, 'Done is in the draft').not.toBeNull()
  expect(close!.y + close!.height, 'Close sits above the title').toBeLessThanOrEqual(title!.y)
  await expect(panel.getByText(/^\d of 6$/)).toBeVisible()
  // The footer holds two buttons on one row, the main action then More (Don't send is inside More), inside the panel's box.
  const actions = await Promise.all(['More', 'Approve and restock'].map(n => panel.getByRole('button', { name: n, exact: true }).boundingBox()))
  const box = await panel.boundingBox()
  for (const b of actions) expect(b).not.toBeNull()
  expect(Math.abs(actions[0]!.y - actions[1]!.y), 'the two buttons share one row').toBeLessThanOrEqual(4)
  expect(actions[1]!.x, 'the main action comes first').toBeLessThan(actions[0]!.x)
  expect(actions[1]!.y + actions[1]!.height, 'the actions stay inside the panel').toBeLessThanOrEqual(box!.y + box!.height)

  await panel.getByRole('button', { name: 'Approve and restock', exact: true }).click()
  // Approve moves straight on to the next waiting draft (the toast holds the Undo).
  await expect(panel.getByRole('heading', { name: '11 returns are not restocked' })).toHaveCount(0)
  await expect(panel.getByRole('heading', { level: 2 })).toBeVisible()
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
  await start(page, '#/approvals')
  await expect(waiting(page)).toHaveText(/·\s6$/)
  await page.getByRole('button', { name: 'Approve all low-risk' }).click()
  await expect(waiting(page)).toHaveText(/·\s3$/)
  const approved = page.getByRole('region', { name: 'Approved today' })
  await expect(approved.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(3)
  await expect(page.getByRole('button', { name: 'Approve all low-risk' })).toHaveCount(0)
  // The sensitive three stay: each one's primary action is Review.
  await expect(page.getByRole('main').getByRole('button', { name: 'Review draft', exact: true })).toHaveCount(3)
  await shot(page, 'approved-all-low-risk-1440')
  await toast(page, 'Approved 3 drafts').getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(waiting(page)).toHaveText(/·\s6$/)
  await expect(approved).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Approve all low-risk' })).toBeVisible()
})

test('Today: the whole card opens the panel from one real button, and the "···" menu does not', async ({ page }) => {
  await start(page, '#/today')
  const card = page.getByRole('article', { name: 'Ridge 30L Pack runs out in 9 days' })
  // The title is a real button; the card has no click handler of its own.
  await card.getByRole('button', { name: 'Ridge 30L Pack runs out in 9 days', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toContainText(/Checked Shopify and PO sheet at /)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // A click on the card's blank area lands on the title's stretched hit area and opens it too.
  await card.click({ position: { x: 200, y: 100 } })
  await expect(page.getByRole('dialog')).toContainText(/Checked Shopify and PO sheet at /)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await card.getByRole('button', { name: 'More actions for Ridge 30L Pack runs out in 9 days' }).click()
  await expect(page.getByRole('menu', { name: 'Card actions' })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

for (const [scenario, text] of [['First day', 'Nothing to approve yet.'], ['Loading', 'Reading your tools']] as const) {
  test(`Approvals, ${scenario}: no sort, no approve-all, no cut text${scenario === 'Loading' ? ', and a loading status' : ''}`, async ({ page }) => {
    await start(page, '#/approvals', scenario)
    await expect(waiting(page)).toBeVisible()
    await expect(page.getByRole('main')).toContainText(text)
    await expect(page.getByRole('combobox', { name: /^Sort drafts/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Approve all low-risk' })).toHaveCount(0)
    if (scenario === 'Loading') await expect(page.getByRole('status').filter({ hasText: 'Reading your tools' })).toHaveCount(1)
    expect(await cutText(page)).toEqual([])
  })
}
