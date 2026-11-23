// Visual tour: every page, stage, scenario and pop-up, one screenshot each.
// Assertions are light; the screenshots are the artifact reviewed by eye.
import { expect, test, type Fx, type Stage, type Theme } from './support/fx.js'
import type { Page } from '@playwright/test'
import { atRest } from './states.js'

// TOUR_THEME=dark captures the same tour in dark mode.
const THEME = process.env.TOUR_THEME ?? ''

async function open(page: Page, fx: Fx, stage: Stage, scenario: string, hash: string) {
  await fx.seed({ stage, scenario, ...(THEME ? { theme: THEME as Theme } : {}), demo: { ambient: 'Always' }, once: false })
  await page.goto('/?demo' + hash)
  await expect(page.locator('main')).toBeVisible() // the page drew (some tour pages are chats, with no h1)
  await atRest(page)
}
const shot = (page: Page, name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true })

const PAGES: [Stage, string, string, string][] = [
  ['Watch', 'Normal', '#/today', '6 things need you today.'],
  ['Watch', 'Normal', '#/approvals', "In Act, today's 6 fixes would be waiting here"],
  ['Watch', 'Normal', '#/chats', 'Approvals and routines start in Act'],
  ['Act', 'Normal', '#/activity', 'Activity'],
  ['Run', 'Normal', '#/activity', 'Chased Kestrel'],
  ['Act', 'Normal', '#/routines', 'Routines'],
  ['Act', 'Normal', '#/tools', 'Being connected'],
  ['Act', 'Normal', '#/tools/shopify', 'What your Inhouse agent can do with Shopify'],
  ['Act', 'Tool disconnected', '#/tools/gorgias', 'Disconnected'],
  ['Act', 'Normal', '#/skills', 'Suggested for Shopify brands'],
  ['Act', 'Normal', '#/usage', 'Breakdown'],
  ['Act', 'Cap reached', '#/usage', '$250.00'],
  ['Act', 'Normal', '#/settings/you-general', 'Profile'],
  ['Act', 'Normal', '#/settings/you-notif', 'Alerts'],
  ['Act', 'Normal', '#/settings/team-memory', 'Suppliers'],
  ['Run', 'Normal', '#/settings/team-limits', 'Jobs your Inhouse agent may finish by itself'],
  ['Act', 'Normal', '#/settings/team-audit', 'Audit log'],
  ['Act', 'Normal', '#/settings/team-data', 'Where your data stays'],
  ['Act', 'First day', '#/today', 'Getting your Inhouse agent ready'],
  ['Act', 'Loading', '#/today', 'Reading your tools'],
  ['Act', 'Cap reached', '#/today', 'Spending cap reached.'],
]

for (const [stage, scenario, hash, text] of PAGES) {
  test(`${stage} · ${scenario} · ${hash}`, async ({ fx, page }) => {
    await open(page, fx, stage, scenario, hash)
    await expect(page.getByText(text, { exact: false }).first()).toBeVisible()
    await shot(page, `${stage}-${scenario}-${hash.replace(/[#/]+/g, '-')}`.replace(/\s+/g, '_'))
  })
}

test('Pop-ups: notifications, account menu, team window, empty chat', async ({ fx, page }) => {
  await open(page, fx, 'Act', 'Normal', '#/today')
  await page.getByRole('button', { name: 'Notifications' }).click()
  await expect(page.getByText('Mark all as read')).toBeVisible()
  await shot(page, 'pop-notifications')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('menu').getByText('sam@northline.example', { exact: true })).toBeVisible()
  await expect(page.getByRole('menu').getByText('Admin', { exact: true })).toBeVisible()
  await shot(page, 'pop-account')
  await page.getByRole('menuitem', { name: /^Your Inhouse team/ }).click()
  await expect(page.getByRole('dialog', { name: 'Your Inhouse team' })).toBeVisible()
  await shot(page, 'pop-team')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'New chat' }).click()
  await expect(page.getByText('What do you want to know?')).toBeVisible()
  await shot(page, 'chat-empty')
})
