// The demo catch-up's PR 1 on a phone (390px), in both themes: the ask cards in their chat, Approvals with a teammate's
// card under "Waiting on your team", and Settings > Always allowed. It would fail if a card, a permission row or its
// Remove scrolled sideways or clipped, Always allow didn't land on Always allowed, Remove didn't take it away after the
// question, or axe (WCAG 2.1 A and AA) found anything. Desktop: asking-demo.spec.ts.
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, fxFor, test, type Theme } from './support/fx.js'

const WHOLESALE = 'Add a tag to order 4512'
const PRIYA = 'Remove a tag from order 4470'

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
/** Every action card and permission row on the page lies inside the screen's width. */
async function fits(page: Page, selector: string) {
  const width = page.viewportSize()!.width
  const boxes = await page.locator(selector).evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return [r.left, r.right] }))
  expect(boxes.length).toBeGreaterThan(0)
  for (const [left, right] of boxes) { expect(left).toBeGreaterThanOrEqual(0); expect(right).toBeLessThanOrEqual(width) }
}

for (const theme of ['light', 'dark'] as const) {
  test(`the ask cards fit a phone in their chat; Always allow lands on Always allowed, and Remove takes it away (${theme})`, async ({ page }) => {
    await start(page, '#/chats/order-tags', theme)
    await expect(cardOf(page, WHOLESALE).locator('[data-card-actions] button')).toHaveText(['Allow once', 'Always allow', 'No'])
    await fits(page, '[data-action-card]')
    await checked(page, `demo-asks-chat-phone-${theme}`)

    await cardOf(page, WHOLESALE).getByRole('button', { name: 'Always allow', exact: true }).click()
    await expect(cardOf(page, WHOLESALE)).toHaveAttribute('data-action-card', 'approved')
    await go(page, '#/settings/you-permissions')
    const made = page.locator('main [data-permission]').filter({ hasText: 'Add tags to orders' })
    await expect(made).toContainText('Up to 50 orders a day, 5 at a time')
    await expect(page.locator('main [data-permission]')).toHaveCount(3)
    await fits(page, 'main [data-permission]')
    await checked(page, `demo-always-allowed-phone-${theme}`)
    await made.getByRole('button', { name: 'Remove: Add tags to orders' }).click()
    await page.getByRole('dialog', { name: 'Stop allowing this?' }).getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(made).toHaveCount(0)
  })

  test(`Approvals on a phone: a teammate's card waits on the team, with no buttons (${theme})`, async ({ page }) => {
    await start(page, '#/approvals', theme)
    await expect(page.getByRole('heading', { name: /^Waiting on your team/ })).toBeVisible()
    await expect(cardOf(page, PRIYA)).toContainText('Waiting for Priya Shah')
    await expect(cardOf(page, PRIYA).locator('[data-card-actions]')).toHaveCount(0)
    await fits(page, '[data-action-card]')
    await checked(page, `demo-approvals-asks-phone-${theme}`)
  })
}
