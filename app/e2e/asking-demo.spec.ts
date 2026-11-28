// The demo catch-up's PR 1: the real agent's asking and Always allow on sample data (sample-data/actions.json,
// mock-actions.ts), on desktop in both themes. The phone's: asking-demo-phone.spec.ts. It would fail if:
//  - an ask card in its chat didn't offer Allow once, Always allow and No (Always allow first when nudged), or Allow once
//    didn't hold 10 seconds on the demo clock and then go out;
//  - Always allow made no permission on Settings > Always allowed, or its Remove (after the question) left it there;
//  - the card that needs a check didn't say so, or "It didn't go out" didn't settle it;
//  - Approvals didn't list a teammate's card, with no buttons, under "Waiting on your team";
//  - the bell didn't carry the approval notices, or a Pause in the hold didn't send the card back to waiting with the
//    server's words, its buttons and an "Approval sent back" notice, or the card went out anyway;
//  - Activity's "Stop allowing this" didn't remove the permission behind an action;
//  - the demo still showed a stage: the switch, Stage and plan, or a demo-only Settings page;
//  - any of these failed axe (WCAG 2.1 A and AA) in light or dark, or scrolled sideways.
// Named screenshots of each state go to the run's artifacts (VERIFY.md's visual proof).
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, fxFor, test, type Theme } from './support/fx.js'

const WHOLESALE = 'Add a tag to order 4512'
const POST = 'Post to #ops-alerts in Slack'
const GIFT = 'Add a tag to order 4377'
const PRIYA = 'Remove a tag from order 4470'
const LAPSED = 'The agent was paused, so this needs your OK again.'

async function start(page: Page, hash: string, theme: Theme = 'light') {
  await page.clock.install()
  await fxFor(page, undefined).seed({ scenario: 'Normal', theme })
  await page.goto('/?demo' + hash)
}
/** Moves within the app without a reload: the demo's cards and permissions live in memory, as the server's do. */
const go = (page: Page, hash: string) => page.evaluate(h => { location.hash = h }, hash)
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
const cardOf = (page: Page, title: string) => page.locator('[data-action-card]').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
const buttons = (page: Page, title: string) => cardOf(page, title).locator('[data-card-actions] button')
const toast = (page: Page, text: string) => page.locator('[data-toast]').filter({ hasText: text })
const permission = (page: Page, title: string) => page.locator('main [data-permission]').filter({ hasText: title })

for (const theme of ['light', 'dark'] as const) {
  test(`the ask cards in their chat: Allow once, Always allow and No, the nudge, and a Needs a check (${theme})`, async ({ page }) => {
    await start(page, '#/chats/order-tags', theme)
    await expect(buttons(page, WHOLESALE)).toHaveText(['Allow once', 'Always allow', 'No'])
    await expect(cardOf(page, WHOLESALE)).toContainText('Shopify · Your Inhouse agent asks first')
    await expect(cardOf(page, WHOLESALE)).toContainText('Tag: Wholesale')
    // Allowed once three times before: Always allow comes first, as the primary button.
    await expect(buttons(page, POST)).toHaveText(['Always allow', 'Allow once', 'No'])
    await expect(cardOf(page, POST)).toContainText("Can't be taken back")
    const gift = cardOf(page, GIFT)
    await expect(gift).toHaveAttribute('data-action-card', 'needs_check')
    await expect(gift).toContainText('Shopify · Needs a check')
    await expect(gift).toContainText('It isn’t clear whether this went out. Check in the tool, then say whether it did.')
    await expect(buttons(page, GIFT)).toHaveText(['It went out', "It didn't go out"])
    await shot(page, `demo-asks-chat-${theme}`, true)
    await axeClean(page, `demo asks chat ${theme}`)
  })

  test(`Always allowed lists the permissions, each with Remove (${theme})`, async ({ page }) => {
    await start(page, '#/settings/you-permissions', theme)
    await expect(page.getByRole('heading', { name: 'Done without asking' })).toBeVisible()
    await expect(permission(page, 'Add stock')).toContainText('Shopify · northline-outdoor · Up to 200 stock units a day, 50 at a time')
    await expect(permission(page, 'Post messages to a channel')).toContainText('Slack · #ops-alerts · Up to 50 posts a day, 1 at a time · For Dana Kim')
    await expect(page.locator('main [data-permission]').getByRole('button', { name: /^Remove: / })).toHaveCount(2)
    await shot(page, `demo-always-allowed-${theme}`, true)
    await axeClean(page, `demo always allowed ${theme}`)
  })

  test(`Approvals: a teammate's card waits on the team, with no buttons; the bell carries the approval notices (${theme})`, async ({ page }) => {
    await start(page, '#/approvals', theme)
    const team = page.locator('section[aria-labelledby="agent-team-actions"]')
    await expect(team.getByRole('heading', { name: /^Waiting on your team/ })).toBeVisible()
    await expect(team.locator('[data-action-card]')).toHaveCount(1)
    await expect(cardOf(page, PRIYA)).toContainText('Shopify · Waiting for Priya Shah')
    await expect(cardOf(page, PRIYA).locator('[data-card-actions]')).toHaveCount(0)
    const mine = page.locator('section[aria-labelledby="agent-actions"]')
    for (const title of [WHOLESALE, POST, GIFT]) await expect(mine.locator('[data-action-card]').filter({ has: page.getByRole('heading', { name: title, exact: true }) })).toHaveCount(1)
    await shot(page, `demo-approvals-asks-${theme}`, true)
    await axeClean(page, `demo approvals asks ${theme}`)

    await page.getByRole('button', { name: /^Notifications/ }).click()
    const bell = page.getByRole('dialog', { name: 'Notifications' })
    for (const text of ['Approval waiting', 'A send needs a check', 'An approval expired']) await expect(bell.getByRole('button', { name: new RegExp(`^${text}`) })).toBeVisible()
    await shot(page, `demo-bell-approvals-${theme}`)
    await axeClean(page, `demo bell ${theme}`)
  })
}

test('Allow once holds 10 seconds, then the card is done', async ({ page }) => {
  await start(page, '#/chats/order-tags')
  await cardOf(page, WHOLESALE).getByRole('button', { name: 'Allow once', exact: true }).click()
  await expect(toast(page, 'Allowed once. It goes out in a few seconds.')).toBeVisible()
  await expect(cardOf(page, WHOLESALE)).toHaveAttribute('data-action-card', 'approved')
  await expect(cardOf(page, WHOLESALE).locator('[data-hold]')).toContainText(/Goes out in \d+ seconds?/)
  await expect(buttons(page, WHOLESALE)).toHaveText(['Undo'])
  await page.clock.runFor(14_000)
  await expect(cardOf(page, WHOLESALE)).toHaveAttribute('data-action-card', 'sent')
  await expect(cardOf(page, WHOLESALE)).toContainText('Sent.')
  await expect(cardOf(page, WHOLESALE).locator('[data-card-actions]')).toHaveCount(0)
})

test('Always allow makes the permission; Always allowed shows it, and Remove takes it away after the question', async ({ page }) => {
  await start(page, '#/chats/order-tags')
  await cardOf(page, WHOLESALE).getByRole('button', { name: 'Always allow', exact: true }).click()
  await expect(toast(page, "Allowed. Your Inhouse agent won't ask next time.")).toBeVisible()
  // Undo in the hold takes back this action only: the permission stays, and the card says where to remove it.
  await cardOf(page, WHOLESALE).getByRole('button', { name: `Undo: ${WHOLESALE}` }).click()
  await expect(cardOf(page, WHOLESALE)).toContainText('Always allow stays on. Remove it in Settings, Always allowed.')

  await go(page, '#/settings/you-permissions')
  const made = permission(page, 'Add tags to orders')
  await expect(made).toContainText('Shopify · northline-outdoor · Up to 50 orders a day, 5 at a time')
  await made.getByRole('button', { name: 'Remove: Add tags to orders' }).click()
  const ask = page.getByRole('dialog', { name: 'Stop allowing this?' })
  await expect(ask).toContainText('Add tags to orders. Your Inhouse agent will ask before it does this again.')
  await shot(page, 'demo-always-allowed-remove')
  await ask.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(toast(page, 'Removed. Your Inhouse agent will ask first from now on.')).toBeVisible()
  await expect(made).toHaveCount(0)
  await expect(page.locator('main [data-permission]')).toHaveCount(2)
})

test("Needs a check: It didn't go out settles the card", async ({ page }) => {
  await start(page, '#/chats/order-tags')
  await cardOf(page, GIFT).getByRole('button', { name: `It didn't go out: ${GIFT}` }).click()
  await expect(toast(page, 'Marked as not sent.')).toBeVisible()
  await expect(cardOf(page, GIFT)).toHaveAttribute('data-action-card', 'failed')
  await expect(cardOf(page, GIFT)).toContainText('It didn’t go out.')
  await expect(cardOf(page, GIFT).locator('[data-card-actions]')).toHaveCount(0)
})

test('Pause in the hold sends the card back to waiting, with a bell notice; it goes out only once allowed again', async ({ page }) => {
  await start(page, '#/chats/order-tags')
  await cardOf(page, WHOLESALE).getByRole('button', { name: 'Allow once', exact: true }).click()
  await expect(cardOf(page, WHOLESALE)).toHaveAttribute('data-action-card', 'approved')

  // Pause lives on the Spending cap page; the card waits in its chat, read again when the server says it changed.
  await go(page, '#/settings/team-spend')
  await page.locator('main').getByRole('button', { name: 'Pause Inhouse agent', exact: true }).click()
  await expect(page.getByRole('status', { name: 'Inhouse agent is paused', exact: true })).toBeVisible()
  await go(page, '#/chats/order-tags')
  await expect(cardOf(page, WHOLESALE)).toHaveAttribute('data-action-card', 'waiting')
  await expect(cardOf(page, WHOLESALE)).toContainText(LAPSED)
  await expect(buttons(page, WHOLESALE)).toHaveText(['Allow once', 'Always allow', 'No'])
  await page.clock.runFor(20_000)
  await expect(cardOf(page, WHOLESALE)).toHaveAttribute('data-action-card', 'waiting')
  await shot(page, 'demo-paused-sent-back')

  await page.getByRole('button', { name: /^Notifications/ }).click()
  const bell = page.getByRole('dialog', { name: 'Notifications' })
  await expect(bell.getByRole('button', { name: /^Approval sent back/ })).toContainText('Unread')
  await page.keyboard.press('Escape')

  // While paused, no approval is taken (the card is read again and still waits).
  await cardOf(page, WHOLESALE).getByRole('button', { name: 'Allow once', exact: true }).click()
  await expect(cardOf(page, WHOLESALE).getByRole('alert')).toContainText('This changed before your answer arrived.')
  await expect(cardOf(page, WHOLESALE)).toHaveAttribute('data-action-card', 'waiting')
  // Resumed, Allow once goes through and the card goes out after its hold.
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await cardOf(page, WHOLESALE).getByRole('button', { name: 'Allow once', exact: true }).click()
  await expect(cardOf(page, WHOLESALE)).toHaveAttribute('data-action-card', 'approved')
  await page.clock.runFor(14_000)
  await expect(cardOf(page, WHOLESALE)).toHaveAttribute('data-action-card', 'sent')
})

test("Activity's Stop allowing this removes the permission behind an action", async ({ page }) => {
  await start(page, '#/activity')
  const row = page.locator('[data-activity-action]').filter({ hasText: 'Add 40 units of stock to item 8012' })
  await expect(row).toContainText('Sent.')
  await row.getByRole('button', { name: 'Stop allowing this: Add 40 units of stock to item 8012' }).click()
  const ask = page.getByRole('dialog', { name: 'Stop allowing this?' })
  await expect(ask).toContainText('Add stock. Your Inhouse agent will ask before it does this again.')
  await ask.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(toast(page, 'Removed. Your Inhouse agent will ask first from now on.')).toBeVisible()
  await expect(row.getByRole('button', { name: /^Stop allowing this/ })).toHaveCount(0)
  await go(page, '#/settings/you-permissions')
  await expect(permission(page, 'Add stock')).toHaveCount(0)
})

test('the demo has no stage: no switch, no Stage and plan, no demo-only Settings page', async ({ page }) => {
  await start(page, '#/settings/you-general')
  await page.getByRole('button', { name: /^Demo switches/ }).click()
  const panel = page.getByRole('dialog', { name: 'Demo switches' })
  await expect(panel.getByText('Scenario', { exact: true })).toBeVisible()
  await expect(panel.getByText('Stage', { exact: true })).toHaveCount(0)
  await expect(panel.getByRole('radio', { name: /^(Watch|Act|Run)$/ })).toHaveCount(0)
  await panel.getByRole('button', { name: 'Close demo switches' }).click()
  const menu = page.getByRole('navigation', { name: 'Settings' })
  for (const label of ['Stage and plan', 'Who approves what', 'Run limits', 'Notifications']) await expect(menu.getByRole('button', { name: label, exact: true })).toHaveCount(0)
  await expect(menu.getByRole('button', { name: 'Always allowed', exact: true })).toBeVisible()
  // A saved link to a gone page lands on the first page.
  await go(page, '#/settings/team-plan')
  await expect(page.getByRole('heading', { name: 'General', level: 1 })).toBeVisible()
})
