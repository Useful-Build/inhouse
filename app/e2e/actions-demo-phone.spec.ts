// Stage 1 M3-U in the demo, on a phone (390px): the batch card in its chat and its full list, a bottom sheet, in both
// themes. It would fail if the card or the sheet scrolled sideways or clipped, the sheet didn't list every change, its
// Approve didn't name and cover what it showed, or axe (WCAG 2.1 A and AA) found anything. Desktop: actions-demo.spec.ts.
import AxeBuilder from '@axe-core/playwright'
import type { Locator, Page } from '@playwright/test'
import { expect, fxFor, test, type Theme } from './support/fx.js'

const BATCH = 'Tag 450 orders as VIP'
const APPROVE = 'Approve all 450'

async function start(page: Page, hash: string, theme: Theme) {
  await page.clock.install()
  await fxFor(page, undefined).seed({ scenario: 'Normal', theme })
  await page.goto('/?demo' + hash)
}
const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.timeline instanceof DocumentTimeline && a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)))
async function checked(page: Page, name: string) {
  await settled(page)
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  expect(violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`), name).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${name} scrolls sideways`).toBe(true)
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) })
}
/** Scrolls the full list to its end until every row is read (it reads 100 more each time its end shows). */
async function readAll(sheet: Locator, n: number) {
  const list = sheet.locator('[data-sheet-list]')
  await expect.poll(async () => { await list.evaluate(el => { el.scrollTop = el.scrollHeight }); return sheet.locator('[data-item]').count() }, { timeout: 30_000 }).toBe(n)
}
const batchCard = (page: Page) => page.locator('[data-action-card]').filter({ has: page.getByRole('heading', { name: BATCH }) })

for (const theme of ['light', 'dark'] as const) {
  test(`the batch card fits a phone in its chat, and its full list is a bottom sheet (${theme})`, async ({ page }) => {
    await start(page, '#/chats/vip-tags', theme)
    const card = batchCard(page)
    await expect(card.locator('[data-card-more]')).toHaveText('and 447 moreSee all 450')
    await card.scrollIntoViewIfNeeded()
    const box = (await card.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width)
    await checked(page, `demo-batch-chat-phone-${theme}`)

    await card.getByRole('button', { name: `See all 450: ${BATCH}` }).click()
    const sheet = page.getByRole('dialog', { name: BATCH })
    await readAll(sheet, 450)
    await sheet.locator('[data-item]').nth(200).scrollIntoViewIfNeeded()
    await checked(page, `demo-batch-sheet-phone-${theme}`)
    await sheet.getByRole('button', { name: APPROVE }).click()
    await expect(page.locator('[data-toast]').filter({ hasText: 'Approved 450. They start going out in a few seconds.' })).toBeVisible()
    await expect(card.getByRole('timer')).toHaveText(/^Goes out in \d+ seconds?$/)
  })
}
