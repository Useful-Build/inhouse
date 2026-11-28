// The demo catch-up's PR 3 on a phone (390px), in both themes: Approvals' "Questions for you", What the agent can do, the
// batch that partly went out in its chat and its full list, and Approvals as a member. It would fail if a question, a
// ceiling row, a card or the sheet scrolled sideways or clipped, an answer didn't close its question, the full list didn't
// mark the items that didn't go out, or axe (WCAG 2.1 A and AA) found anything. Desktop: questions-ceiling-demo.spec.ts.
import AxeBuilder from '@axe-core/playwright'
import type { Locator, Page } from '@playwright/test'
import { expect, fxFor, test, type Theme } from './support/fx.js'

const CHAT_Q = 'Should I post the Wholesale heads-up in #ops-alerts for every wholesale order, or only for orders over $1,000?'
const LOYALTY = 'Tag 450 orders as Loyalty'
const REFUND = 'Refund $238.00 (USD) on order 4838'

async function start(page: Page, hash: string, theme: Theme) {
  await page.clock.install()
  await fxFor(page, undefined).seed({ scenario: 'Normal', theme })
  await page.goto('/?demo' + hash)
}
const go = (page: Page, hash: string) => page.evaluate(h => { location.hash = h }, hash)
const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.timeline instanceof DocumentTimeline && a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)))
async function checked(page: Page, name: string) {
  await settled(page)
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  expect(violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`), name).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${name} scrolls sideways`).toBe(true)
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true })
}
const cardOf = (page: Page, title: string) => page.locator('[data-action-card]').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
/** Every element the selector finds lies inside the screen's width. */
async function fits(page: Page, selector: string) {
  const width = page.viewportSize()!.width
  const boxes = await page.locator(selector).evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return [r.left, r.right] }))
  expect(boxes.length).toBeGreaterThan(0)
  for (const [left, right] of boxes) { expect(left).toBeGreaterThanOrEqual(0); expect(right).toBeLessThanOrEqual(width) }
}
/** Scrolls the full list to its end until every row is read (it reads 100 more each time its end shows). */
async function readAll(sheet: Locator, n: number) {
  const list = sheet.locator('[data-sheet-list]')
  await expect.poll(async () => { await list.evaluate(el => { el.scrollTop = el.scrollHeight }); return sheet.locator('[data-item]').count() }, { timeout: 30_000 }).toBe(n)
}

for (const theme of ['light', 'dark'] as const) {
  test(`Approvals on a phone: the two questions fit, and an answer closes its question (${theme})`, async ({ page }) => {
    await start(page, '#/approvals', theme)
    const questions = page.locator('[data-question]')
    await expect(questions).toHaveCount(2)
    await fits(page, '[data-question]')
    await checked(page, `demo-questions-phone-${theme}`)
    await page.locator('[data-question]').filter({ has: page.getByRole('heading', { name: CHAT_Q, exact: true }) }).getByRole('button', { name: 'Every wholesale order', exact: true }).click()
    await expect(page.locator('[data-question="answered"]')).toContainText('You answered: Every wholesale order')
  })

  test(`What the agent can do fits a phone: seven rows, none editable (${theme})`, async ({ page }) => {
    await start(page, '#/settings/team-ceiling', theme)
    await expect(page.locator('main [data-ceiling]')).toHaveCount(7)
    await expect(page.locator('main').getByRole('button', { name: /^Change: / })).toHaveCount(0)
    await fits(page, 'main [data-ceiling]')
    await checked(page, `demo-ceiling-phone-${theme}`)
  })

  test(`the batch that partly went out fits a phone, and its full list marks the 3 that did not (${theme})`, async ({ page }) => {
    await start(page, '#/chats/loyalty-tags', theme)
    const card = cardOf(page, LOYALTY)
    await expect(card).toContainText('Sent. 447 of 450 went out')
    await fits(page, '[data-action-card]')
    await checked(page, `demo-batch-partly-sent-phone-${theme}`)
    await card.getByRole('button', { name: `See all 450: ${LOYALTY}` }).click()
    const sheet = page.getByRole('dialog', { name: LOYALTY })
    await readAll(sheet, 450)
    await expect(sheet.locator('[data-item-state="failed"]')).toHaveCount(3)
    await sheet.locator('[data-item-state="failed"]').first().scrollIntoViewIfNeeded()
    await checked(page, `demo-batch-partly-sent-list-phone-${theme}`)
  })

  test(`View as Member on a phone: the refund waits for an admin and can be withdrawn (${theme})`, async ({ page }) => {
    await start(page, '#/approvals', theme)
    await expect(page.locator('[data-action-card]').first()).toBeVisible()
    await page.getByRole('button', { name: /^Demo switches:/ }).click()
    const panel = page.getByRole('dialog', { name: 'Demo switches' })
    await panel.getByRole('radio', { name: 'Member', exact: true }).click()
    await expect(panel.getByRole('radio', { name: 'Member', exact: true })).toBeChecked()
    await panel.getByRole('button', { name: 'Close demo switches' }).click()
    await expect(cardOf(page, REFUND)).toContainText('Waiting for an admin')
    await expect(cardOf(page, REFUND).locator('[data-card-actions] button')).toHaveText(['Withdraw'])
    await fits(page, '[data-action-card]')
    await checked(page, `demo-approvals-member-phone-${theme}`)
    await go(page, '#/settings/you-permissions')
    await expect(page.locator('main [data-permission]')).toHaveCount(1)
  })
}
