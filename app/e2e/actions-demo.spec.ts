// Stage 1 M3-U in the demo: the real agent's batch card and admins card on sample data (sample-data/actions.json,
// mock-actions.ts), on desktop and phone, in both themes. It would fail if:
//  - the 450-change batch didn't show in its chat with its title, one quiet line ("One approval covers all 450"), 3 rows,
//    "and 447 more" with "See all 450" and "Approve all 450", or showed on day one (the demo has no stages, decision A13);
//  - "See all 450" didn't list every change, in order, its search didn't narrow them, or its Approve covered another count;
//  - the 12-item restock didn't show as a table (column heads, 5 rows) with its total in the header;
//  - the approval didn't hold for 10 seconds on the demo clock and then say all 450 went out;
//  - Approvals didn't list the batch and a teammate's refund (any admin answers it) under "Actions for you";
//  - any of these failed axe (WCAG 2.1 A and AA) in light or dark, or scrolled sideways.
// Named screenshots of each state go to the run's artifacts (the design checkpoint and VERIFY.md's visual proof). The
// phone's: actions-demo-phone.spec.ts.
import AxeBuilder from '@axe-core/playwright'
import type { Locator, Page } from '@playwright/test'
import { expect, fxFor, test, type Theme } from './support/fx.js'

const BATCH = 'Tag 450 orders as VIP'
const APPROVE = 'Approve all 450'

async function start(page: Page, hash: string, o: { theme?: Theme } = {}) {
  await page.clock.install()
  await fxFor(page, undefined).seed({ scenario: 'Normal', theme: o.theme ?? 'light' })
  await page.goto('/?demo' + hash)
}

const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.timeline instanceof DocumentTimeline && a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)))
const shot = async (page: Page, name: string, fullPage = false) => {
  await settled(page)
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage })
}
async function axeClean(page: Page, name: string) {
  await settled(page)
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  expect(violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`), name).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${name} scrolls sideways`).toBe(true)
}
/** Scrolls the full list to its end until every row is read (it reads 100 more each time its end shows). */
async function readAll(sheet: Locator, n: number) {
  const list = sheet.locator('[data-sheet-list]')
  await expect.poll(async () => { await list.evaluate(el => { el.scrollTop = el.scrollHeight }); return sheet.locator('[data-item]').count() }, { timeout: 30_000 }).toBe(n)
}
const batchCard = (page: Page) => page.locator('[data-action-card]').filter({ has: page.getByRole('heading', { name: BATCH }) })

for (const theme of ['light', 'dark'] as const) {
  test(`the batch card in its chat (${theme}): a quiet summary, 3 rows, See all and Approve all`, async ({ page }) => {
    await start(page, '#/chats/vip-tags', { theme })
    const card = batchCard(page)
    await expect(card).toBeVisible()
    await expect(card.locator('[data-card-subtitle]')).toHaveText('Shopify · One approval covers all 450')
    const rows = card.locator('[data-card-rows] [data-row]')
    await expect(rows).toHaveCount(3)
    // Each row: the order's name, its customer, the change and the order's total (the store's facts, as the real card's).
    await expect(rows.first()).toHaveText('#3901Alex Mooreadd VIP$642.10')
    await expect(rows.last()).toHaveText('#3903Jonas Weberadd VIP$517.45')
    await expect(card.locator('[data-card-more]')).toHaveText('and 447 moreSee all 450')
    await expect(card.locator('[data-card-actions] button')).toHaveText([APPROVE, 'No'])
    await expect(card.getByRole('button', { name: `See all 450: ${BATCH}` })).toBeVisible()
    await card.scrollIntoViewIfNeeded()
    await shot(page, `demo-batch-chat-${theme}`)
    await axeClean(page, `demo batch chat ${theme}`)
  })
}

test('See all lists every change in order; its Approve covers the 450 it names, holds, then all 450 go out', async ({ page }) => {
  await start(page, '#/chats/vip-tags')
  const card = batchCard(page)
  await card.getByRole('button', { name: `See all 450: ${BATCH}` }).click()
  const sheet = page.getByRole('dialog', { name: BATCH })
  await expect(sheet).toBeVisible()
  const items = sheet.locator('[data-item]')
  await readAll(sheet, 450)
  await expect(items.nth(0)).toHaveText('#3901Alex Mooreadd VIP$642.10')
  await expect(items.nth(449)).toHaveText('#4350Hana Satoadd VIP$560.00')
  // The footer adds no totals line for a list: the header says it.
  await expect(sheet.locator('[data-sheet-totals]')).toHaveCount(0)
  // A search narrows the rows on their own words.
  await sheet.getByRole('searchbox', { name: 'Search orders' }).fill('4123')
  await expect(items).toHaveCount(1)
  await expect(items.first()).toHaveText('#4123Diego Ramosadd VIP$1,045.20')
  await sheet.getByRole('searchbox', { name: 'Search orders' }).fill('')
  await expect(items).toHaveCount(450)
  await items.nth(200).scrollIntoViewIfNeeded()
  await shot(page, 'demo-batch-sheet-desktop-light')
  await axeClean(page, 'demo batch sheet light')

  await sheet.getByRole('button', { name: APPROVE }).click()
  await expect(sheet).toBeHidden()
  await expect(page.locator('[data-toast]').filter({ hasText: 'Approved 450. They start going out in a few seconds.' })).toBeVisible()
  await expect(card.getByRole('timer')).toHaveText(/^Goes out in \d+ seconds?$/)
  await expect(card.getByRole('button', { name: `Undo: ${BATCH}` })).toBeVisible()
  // The hold ends on the demo clock, and the card reads itself until it settles.
  await page.clock.runFor(14_000)
  await expect(card).toHaveAttribute('data-action-card', 'sent')
  await expect(card).toContainText('Sent. 450 of 450 went out')
})

test('No on the batch: nothing goes out, and the card offers nothing more', async ({ page }) => {
  await start(page, '#/chats/vip-tags')
  const card = batchCard(page)
  await card.getByRole('button', { name: 'No', exact: true }).click()
  await expect(card).toContainText('You said no. Nothing went out.')
  await expect(card.locator('[data-card-actions] button')).toHaveCount(0)
})

for (const theme of ['light', 'dark'] as const) {
  test(`Approvals lists both batches (a list and a table) and a teammate's refund for any admin (${theme})`, async ({ page }) => {
    await start(page, '#/approvals', { theme })
    const section = page.locator('section[aria-labelledby="agent-actions"]')
    await expect(section.getByRole('heading', { name: /^Actions for you/ })).toBeVisible()
    await expect(batchCard(page)).toBeVisible()
    // Rows with quantities are a table, its total in the header.
    const restock = page.locator('[data-action-card]').filter({ has: page.getByRole('heading', { name: 'Restock 12 items' }) })
    await expect(restock.locator('[data-card-total]')).toHaveText('12 changes · 2,400 stock units')
    await expect(restock.locator('th')).toHaveText(['Item', 'Where and why', 'Stock'])
    await expect(restock.locator('tbody tr')).toHaveCount(5)
    await expect(restock.locator('tbody tr').first()).toHaveText('Item 8001Location 601 · stock received+20')
    await expect(restock.locator('[data-card-actions] button')).toHaveText(['Approve all 12', 'No'])
    const refund = page.locator('[data-action-card]').filter({ has: page.getByRole('heading', { name: 'Refund $238.00 (USD) on order 4838' }) })
    await expect(refund).toContainText('Dana Kim asks an admin')
    await expect(refund).toContainText('Moves money')
    // The order's name, its customer and the refund's amount (the store's facts, display only).
    await expect(refund.locator('[data-card-detail] [data-row]')).toHaveText('#4838Nora Lindqvist$238.00')
    await expect(refund.locator('[data-card-actions] button')).toHaveText(['Approve', 'No'])
    await shot(page, `demo-approvals-desktop-${theme}`, true)
    await axeClean(page, `demo approvals ${theme}`)
  })
}

test('none on day one (no tools yet)', async ({ page }) => {
  await page.clock.install()
  await fxFor(page, undefined).seed({ scenario: 'First day' })
  await page.goto('/?demo#/approvals')
  await expect(page.getByText('Nothing to approve yet.')).toBeVisible()
  await expect(page.locator('[data-action-card]')).toHaveCount(0)
})
