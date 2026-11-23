// Example ship spec: two short scenarios, recorded on video by the `ship` workflow (SHIP=1, see playwright.config.ts).
// Runs at 1440x900 and 390x844. State is seeded through the `fx` fixture, like the other specs.
import { expect, test, type Fx } from '../support/fx.js'
import type { Page } from '@playwright/test'

async function start(page: Page, fx: Fx, hash = '#/today') {
  await fx.seed({ stage: 'Act', demo: { ambient: 'Always' } })
  await page.goto('/?demo' + hash)
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
}

test('S1: Today shows what needs you', async ({ fx, page }) => {
  await start(page, fx)
  await expect(page.getByText('6 things need you. Drafts are ready.')).toBeVisible()
})

test('S2: Settings opens on General', async ({ fx, page }) => {
  await start(page, fx)
  // On a phone the account menu lives in the drawer; on desktop the sidebar is always there.
  const menuButton = page.getByRole('button', { name: 'Menu' })
  if (await menuButton.isVisible()) await menuButton.click()
  const side = page.getByRole('complementary', { name: 'Sidebar' })
  await side.getByRole('button', { name: /account and settings/i }).click()
  await page.getByRole('menu', { name: 'Account' }).getByRole('menuitem', { name: 'Your settings' }).click()
  await page.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'General' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'General' })).toBeVisible()
})
