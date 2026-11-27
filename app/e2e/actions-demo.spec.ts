// Stage 1 M3-U in the demo: the real agent's batch card and admins card on sample data (sample-data/actions.json,
// mock-actions.ts), on desktop and phone, in both themes. It would fail if:
//  - the 450-change batch didn't show in its chat (Act) with its first 10 lines, "and 440 more", its totals and an
//    Approve that names exactly what it covers, or showed on day one (the stage doesn't matter: the stages are going);
//  - "See all 450" didn't list every change, in order, or its Approve covered another count than the one it named;
//  - the approval didn't hold for 10 seconds on the demo clock and then say all 450 went out;
//  - Approvals didn't list the batch and a teammate's refund (any admin answers it) under "Actions for you";
//  - any of these failed axe (WCAG 2.1 A and AA) in light or dark, or scrolled sideways.
// Named screenshots of each state go to the run's artifacts (the design checkpoint and VERIFY.md's visual proof).
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, fxFor, test, type Stage, type Theme } from './support/fx.js'

const BATCH = '450 changes in Shopify'
const APPROVE = 'Approve these 450: 450 orders'
const phone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 600

async function start(page: Page, hash: string, o: { stage?: Stage; theme?: Theme } = {}) {
  await page.clock.install()
  await fxFor(page, undefined).seed({ stage: o.stage ?? 'Act', scenario: 'Normal', theme: o.theme ?? 'light' })
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
const batchCard = (page: Page) => page.locator('[data-action-card]').filter({ has: page.getByRole('heading', { name: BATCH }) })

for (const theme of ['light', 'dark'] as const) {
  test(`the batch card in its chat (${theme}): first lines, totals and an Approve naming what it covers`, async ({ page }) => {
    await start(page, '#/chats/vip-tags', { theme })
    const card = batchCard(page)
    await expect(card).toBeVisible()
    await expect(card).toContainText('Needs your approval')
    const lines = card.locator('[data-card-lines] li')
    await expect(lines).toHaveCount(11)
    await expect(lines.first()).toHaveText('Order 3901 (northline-outdoor): add VIP')
    await expect(lines.nth(9)).toHaveText('Order 3910 (northline-outdoor): add VIP')
    await expect(lines.last()).toHaveText('and 440 more')
    await expect(card.locator('[data-batch-totals]')).toContainText('In all: 450 orders')
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
  await expect(items).toHaveCount(450)
  await expect(items.nth(0)).toContainText('Order 3901 (northline-outdoor): add VIP')
  await expect(items.nth(449)).toContainText('Order 4350 (northline-outdoor): add VIP')
  await expect(sheet.locator('[data-sheet-totals]')).toHaveText('450 changes · In all: 450 orders')
  await items.nth(200).scrollIntoViewIfNeeded()
  await shot(page, `demo-batch-sheet-${phone(page) ? 'phone' : 'desktop'}-light`)
  await axeClean(page, 'demo batch sheet light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await shot(page, `demo-batch-sheet-${phone(page) ? 'phone' : 'desktop'}-dark`)

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
  test(`Approvals lists the batch and a teammate's refund for any admin (${theme})`, async ({ page }) => {
    await start(page, '#/approvals', { theme })
    const section = page.locator('section[aria-labelledby="agent-actions"]')
    await expect(section.getByRole('heading', { name: /^Actions for you/ })).toBeVisible()
    await expect(batchCard(page)).toBeVisible()
    const refund = page.locator('[data-action-card]').filter({ has: page.getByRole('heading', { name: 'Refund $238.00 (USD) on order 4838' }) })
    await expect(refund).toContainText('Dana Kim asks an admin')
    await expect(refund).toContainText('Moves money')
    await expect(refund.locator('[data-card-actions] button')).toHaveText(['Approve', 'No'])
    await shot(page, `demo-approvals-${phone(page) ? 'phone' : 'desktop'}-${theme}`, true)
    await axeClean(page, `demo approvals ${theme}`)
  })
}

test('the cards show whatever the stage', async ({ page }) => {
  await start(page, '#/chats/vip-tags', { stage: 'Watch' })
  await expect(batchCard(page)).toBeVisible()
})

test('none on day one (no tools yet)', async ({ page }) => {
  await page.clock.install()
  await fxFor(page, undefined).seed({ stage: 'Act', scenario: 'First day' })
  await page.goto('/?demo#/approvals')
  await expect(page.getByText('Nothing to approve yet.')).toBeVisible()
  await expect(page.locator('[data-action-card]')).toHaveCount(0)
})
