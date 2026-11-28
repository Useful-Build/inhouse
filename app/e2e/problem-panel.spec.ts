// The problem panel's two ways out that aren't approvals, at 1440: "Ask Inhouse" (the panel header's Ask, and the card's
// menu) starts a chat holding the question, which a reload keeps; the window shows no memory line. Approve,
// Edit, Don't send and Undo are in app.spec.ts, today-approvals.spec.ts and page-actions.spec.ts.
import { expect, test, type Fx } from './support/fx.js'
import type { Page } from '@playwright/test'

async function start(page: Page, fx: Fx) {
  await fx.seed({})
  await page.goto('/?demo#/today')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('left to approve today')
}

const card = (page: Page, title: string) => page.getByRole('article', { name: title })
const panel = (page: Page) => page.getByRole('dialog')
/** The question as sent, in the conversation (not the answer, not the chat's title). */
const sent = (page: Page, text: string) =>
  page.getByRole('log', { name: 'Conversation' }).locator('[data-chat-msg]:not([data-answer])').filter({ hasText: text })
const STUCK = 'Order #4821 is stuck for 4 days'
/** The payout's post leans on team memory (its rate card); the oversell is a finding since #726. */
const PAYOUT = 'Amazon paid out $1,240 less than expected'

test('Problem panel: Ask starts a chat with the question, the panel closes, and a reload keeps the chat', async ({ fx, page }) => {
  await start(page, fx)
  await card(page, STUCK).click({ position: { x: 12, y: 12 } })
  await expect(panel(page)).toBeVisible()
  // Outside Watch, Ask Inhouse is in the window's More menu (the main button is the draft's outcome).
  await panel(page).getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('menu', { name: 'More actions' }).getByRole('menuitem', { name: 'Ask Inhouse', exact: true }).click()

  const question = `Tell me more about: ${STUCK}`
  await expect(panel(page)).toHaveCount(0)
  await expect(page).toHaveURL(/#\/chats\/(?!new$|all$)[^/]+$/)
  await expect(sent(page, question)).toHaveCount(1)
  const url = page.url()

  // The question is the chat: it's still there after a reload, at the same link.
  await page.reload()
  await expect(page).toHaveURL(url)
  await expect(sent(page, question)).toHaveCount(1)

  // The card itself is untouched: still on Today, still needing you.
  await page.evaluate(() => { location.hash = '#/today' })
  await expect(card(page, STUCK)).toBeVisible()
})

test("Card menu: Ask Inhouse starts the same chat without opening the panel; the review window shows no memory line", async ({ fx, page }) => {
  await start(page, fx)
  await card(page, STUCK).getByRole('button', { name: 'More' }).click()
  const menu = page.getByRole('menu', { name: 'Card actions' })
  await expect(menu).toBeVisible()
  // The menu opened on its own: no problem panel behind it.
  await expect(panel(page)).toHaveCount(0)
  await menu.getByRole('menuitem', { name: 'Ask Inhouse', exact: true }).click()
  await expect(page).toHaveURL(/#\/chats\/(?!new$|all$)[^/]+$/)
  await expect(sent(page, `Tell me more about: ${STUCK}`)).toHaveCount(1)

  // A drafted fix that leans on memory opens without the memory line or its Manage button: the review window leaves
  // mechanics out (UI plan 3, round 4). Team memory stays one click away in Settings.
  await page.evaluate(() => { location.hash = '#/today' })
  await card(page, PAYOUT).click({ position: { x: 12, y: 12 } })
  await expect(panel(page).getByRole('heading', { level: 2, name: PAYOUT })).toBeVisible()
  await expect(panel(page)).not.toContainText('Remembered')
  await expect(panel(page).getByRole('button', { name: 'Manage', exact: true })).toHaveCount(0)
})
