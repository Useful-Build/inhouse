// The problem panel's two ways out that aren't approvals, at 1440: "Ask about this…" (in the panel and in the card's
// menu) starts a chat holding the question, which a reload keeps; the memory note's Manage opens Team memory. Approve,
// Edit, Don't send and Undo are in app.spec.ts, today-approvals.spec.ts and page-actions.spec.ts.
import { expect, test } from './csp.js'
import type { Page } from '@playwright/test'

async function start(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-seeded')) return
    localStorage.clear()
    localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: 'Act', scenario: 'Normal', ambient: 'Off', animateMark: false }))
    sessionStorage.setItem('e2e-seeded', '1')
  })
  await page.goto('/?demo#/today')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('things need you')
}

const card = (page: Page, title: string) => page.getByRole('article', { name: title })
const panel = (page: Page) => page.getByRole('dialog')
/** The question as sent, in the conversation (not the answer, not the chat's title). */
const sent = (page: Page, text: string) =>
  page.getByRole('log', { name: 'Conversation' }).locator('[data-chat-msg]:not([data-answer])').filter({ hasText: text })
const STUCK = 'Order #4821 is stuck for 4 days'
const JACKET = 'Trail Shell Jacket (M, Olive) is oversold by 5'

test('Problem panel: Ask about this… starts a chat with the question, the panel closes, and a reload keeps the chat', async ({ page }) => {
  await start(page)
  await card(page, STUCK).click({ position: { x: 12, y: 12 } })
  await expect(panel(page)).toBeVisible()
  await panel(page).getByRole('button', { name: 'Ask about this…' }).click()

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

test("Card menu: Ask about this starts the same chat without opening the panel; the panel's Manage opens Team memory", async ({ page }) => {
  await start(page)
  await card(page, STUCK).getByRole('button', { name: 'More' }).click()
  const menu = page.getByRole('menu', { name: 'Card actions' })
  await expect(menu).toBeVisible()
  // The menu opened on its own: no problem panel behind it.
  await expect(panel(page)).toHaveCount(0)
  await menu.getByRole('menuitem', { name: 'Ask about this', exact: true }).click()
  await expect(page).toHaveURL(/#\/chats\/(?!new$|all$)[^/]+$/)
  await expect(sent(page, `Tell me more about: ${STUCK}`)).toHaveCount(1)

  // A drafted fix that leans on memory says so, and Manage goes to Team memory, closing the panel.
  await page.evaluate(() => { location.hash = '#/today' })
  await card(page, JACKET).click({ position: { x: 12, y: 12 } })
  await expect(panel(page)).toContainText('Remembered: you offer a refund before a discount')
  await panel(page).getByRole('button', { name: 'Manage', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Team memory', exact: true })).toBeVisible()
  await expect(page).toHaveURL(/#\/settings\/team-memory$/)
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
