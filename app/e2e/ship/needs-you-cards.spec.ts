// Ship spec for the needs-you redesign (docs/plans/2026-11-21-needs-you-cards-and-panel.md): the Today cards, the
// Approvals cards and the review panel they open. Recorded at 1440x900 and 390x844. After the first load, every page is
// opened through the UI, as a person would (on a phone the sidebar is the drawer behind Menu).
import { expect, test, type Fx } from '../support/fx.js'
import type { Page } from '@playwright/test'

const phone = () => test.info().project.name === 'ship-phone'

// Titles and copy as src/agent/sample-data/problems.json has them: copied, since a spec reads sample data only through
// `fx` and `fx` doesn't carry the problems.
const JACKET = 'Trail Shell Jacket (M, Olive) is oversold by 5'
const PAYOUT = 'Amazon paid out $1,240 less than expected'
const KESTREL = 'Ridge 30L Pack runs out in 9 days'
const PO = 'PO-1187 from Kestrel is 6 days late'
const RETURNS = '11 returns are not restocked'

const card = (page: Page, title: string) => page.getByRole('article', { name: title, exact: true })
const panel = (page: Page) => page.getByRole('dialog')
const draft = (page: Page, title: string) => page.locator('[data-slot=card]').filter({ has: page.getByRole('heading', { level: 2, name: title, exact: true }) })

async function start(page: Page, fx: Fx, stage: 'Watch' | 'Act' | 'Run' = 'Act', theme: 'light' | 'dark' = 'light') {
  await fx.seed({ stage, theme })
  await page.emulateMedia({ colorScheme: theme })
  await page.goto('/?demo#/today')
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
  await expect(card(page, JACKET)).toBeVisible()
}

async function goApprovals(page: Page) {
  if (phone()) await page.getByRole('button', { name: 'Menu' }).click()
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: /^Approvals/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Approvals' })).toBeVisible()
}

test('S1: Today shows each problem with its drafted fix, urgent ones marked, and a low-risk fix approves in place', async ({ fx, page }) => {
  await start(page, fx)
  // Urgent cards lead with the pill; the others carry no marker.
  await expect(card(page, JACKET).getByText('Urgent', { exact: true })).toBeVisible()
  await expect(card(page, PAYOUT).getByText('Urgent', { exact: true })).toBeVisible()
  await expect(card(page, KESTREL).getByText('Urgent', { exact: true })).toHaveCount(0)
  // Two columns on desktop, one on a phone.
  const a = await card(page, JACKET).boundingBox()
  const b = await card(page, KESTREL).boundingBox()
  if (phone()) expect(b!.y, 'one column').toBeGreaterThan(a!.y + a!.height - 1)
  else expect(Math.abs(b!.y - a!.y), 'two cards share a row').toBeLessThanOrEqual(2)

  // The draft sheet: its kind, the risk, the draft and one summary line.
  const kestrel = card(page, KESTREL)
  await kestrel.scrollIntoViewIfNeeded()
  await expect(kestrel).toContainText('Draft · Purchase order')
  await expect(kestrel).toContainText('Spends $9,600')
  await expect(kestrel).toContainText('Reorder 600 Ridge 30L Packs')
  await expect(kestrel).toContainText('To Kestrel Supply as a PDF. 400 Olive, 200 Black.')
  await expect(card(page, JACKET)).toContainText('Goes to customers')
  await expect(card(page, PAYOUT)).toContainText('Claims $1,240')

  // A low-risk draft approves from the card; the card then shows who approved it, muted.
  const po = card(page, PO)
  await po.scrollIntoViewIfNeeded()
  await expect(po).toContainText('Draft · Email')
  await po.getByRole('button', { name: 'Approve and send to Mei', exact: true }).click()
  await expect(po).toContainText(/Approved by Sam at/)
  await expect(po.getByRole('button', { name: /Approve/ })).toHaveCount(0)
})

test('S2: Review draft opens the panel: progress, facts, how the agent worked it out, the purchase order, then approve', async ({ fx, page }) => {
  await start(page, fx)
  await card(page, KESTREL).scrollIntoViewIfNeeded()
  await card(page, KESTREL).getByRole('button', { name: 'Review draft', exact: true }).click()
  const p = panel(page)
  await expect(p.getByRole('heading', { name: KESTREL })).toBeVisible()
  const progress = p.getByRole('list', { name: 'Progress' })
  await expect(progress).toContainText('Drafted')
  await expect(progress.locator('[aria-current=step]')).toHaveText('Your approval')
  await expect(progress).toContainText('Sent to Kestrel')
  // The facts strip, then the sources folded into one row that opens.
  await expect(p).toContainText('Stock left')
  await expect(p).toContainText('Out of stock for')
  const how = p.getByRole('button', { name: /How your Inhouse agent worked it out/ })
  await expect(how).toHaveAttribute('aria-expanded', 'false')
  await how.click()
  await expect(how).toHaveAttribute('aria-expanded', 'true')
  await expect(p).toContainText('Kestrel lead time, from 6 past orders')
  await how.click()
  // The draft as a document: the purchase order's table and total.
  const doc = p.getByRole('article', { name: 'Purchase order draft' })
  await doc.scrollIntoViewIfNeeded()
  await expect(doc).toContainText('Kestrel Supply')
  await expect(doc.getByRole('table')).toContainText('Ridge 30L Pack · Olive')
  await expect(doc.getByRole('table')).toContainText('$9,600')
  // Edit sits on the document now; Done ends it.
  await doc.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(doc.getByRole('button', { name: 'Done', exact: true })).toBeVisible()
  await doc.getByRole('button', { name: 'Done', exact: true }).click()
  // The footer: the approver, Don't send and the main action with the amount it moves.
  await expect(p).toContainText('Dana Kim usually signs off orders over $5,000')
  await expect(p.getByRole('button', { name: "Don't send", exact: true })).toBeVisible()
  await p.getByRole('button', { name: /^Approve and send to Kestrel\s*\$9,600$/ }).click()
  await expect(progress.locator('[aria-current=step]')).toHaveCount(0)
  await expect(p).toContainText('Approved by Sam')
  await page.keyboard.press('Escape')
  await expect(p).toHaveCount(0)
})

test('S3: Approvals lists each draft as one card with its risk, and Ask in the panel header starts a chat', async ({ fx, page }) => {
  await start(page, fx)
  await goApprovals(page)
  await expect(page.getByRole('button', { name: /^Approve all low-risk\s*3$/ })).toBeVisible()
  const claim = draft(page, 'Open a reimbursement case')
  await expect(claim.getByText('Urgent', { exact: true })).toBeVisible()
  await expect(claim.getByText('Claims $1,240', { exact: true })).toBeVisible()
  await expect(claim).toContainText('From Amazon · Xero')
  const emails = draft(page, 'Pause the variant and email 5 customers')
  await emails.scrollIntoViewIfNeeded()
  await expect(emails.getByText('Goes to customers', { exact: true })).toBeVisible()
  await expect(emails).toContainText('Email to customers, in your tone')
  await expect(emails).toContainText('Leo Park usually signs off customer emails.')
  const restock = draft(page, 'Restock 11 units on Shopify')
  await restock.scrollIntoViewIfNeeded()
  await expect(restock.getByText('Low risk', { exact: true })).toBeVisible()
  await expect(restock.getByRole('button', { name: 'Approve and restock', exact: true })).toBeVisible()

  // Review draft opens the same panel; its header's Ask starts a chat about the problem.
  await claim.scrollIntoViewIfNeeded()
  await claim.getByRole('button', { name: 'Review draft', exact: true }).click()
  await expect(panel(page).getByRole('heading', { name: PAYOUT })).toBeVisible()
  await expect(panel(page)).toContainText('Missing')
  await panel(page).getByRole('button', { name: 'Ask about this', exact: true }).click()
  await expect(panel(page)).toHaveCount(0)
  await expect(page).toHaveURL(/#\/chats\/(?!new$|all$)[^/]+$/)
})

test('S4: In dark, the cards and the panel keep the draft sheet and the document readable', async ({ fx, page }) => {
  await start(page, fx, 'Act', 'dark')
  await expect(card(page, JACKET)).toContainText('Draft · Shopify and 5 emails')
  await card(page, KESTREL).scrollIntoViewIfNeeded()
  await card(page, KESTREL).getByRole('button', { name: 'Ridge 30L Pack runs out in 9 days', exact: true }).click()
  await expect(panel(page).getByRole('article', { name: 'Purchase order draft' })).toBeVisible()
  await panel(page).getByRole('article', { name: 'Purchase order draft' }).scrollIntoViewIfNeeded()
  await page.keyboard.press('Escape')
  await goApprovals(page)
  await expect(draft(page, 'Reorder 600 Ridge 30L Packs').getByText('Spends $9,600', { exact: true })).toBeVisible()
})

test('S5: Watch shows when the agent found it; in Run a handled card stays muted and its panel shows every step done', async ({ fx, page }) => {
  await start(page, fx, 'Watch')
  await expect(card(page, JACKET)).toContainText(/Suggested:/)
  await card(page, KESTREL).getByRole('button', { name: KESTREL, exact: true }).click()
  await expect(panel(page)).toContainText(/Found \d/)
  await expect(panel(page).getByRole('list', { name: 'Progress' })).toHaveCount(0)
  await expect(panel(page)).toContainText('Suggested next step')
  await page.keyboard.press('Escape')

  await fx.restage({ stage: 'Run' })
  await page.reload()
  const returns = card(page, RETURNS)
  await returns.scrollIntoViewIfNeeded()
  await expect(returns).toContainText('Handled by Inhouse agent')
  await expect(returns.getByText('Urgent', { exact: true })).toHaveCount(0)
  await returns.getByRole('button', { name: RETURNS, exact: true }).click()
  const progress = panel(page).getByRole('list', { name: 'Progress' })
  await expect(progress).toContainText('Handled by your agent')
  await expect(progress.locator('[aria-current=step]')).toHaveCount(0)
  await expect(panel(page).getByRole('button', { name: "Don't send" })).toHaveCount(0)
})
