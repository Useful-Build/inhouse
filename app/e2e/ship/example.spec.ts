// Example ship spec: two short scenarios, recorded on video by the `ship` workflow (SHIP=1, see playwright.config.ts).
// Runs at 1440x900 and 390x844. State is seeded through localStorage and `?demo`, like the other specs.
import { expect, test } from '../csp.js'
import type { Page } from '@playwright/test'

async function start(page: Page, hash = '#/today') {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-seeded')) return
    localStorage.clear()
    localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: 'Act', scenario: 'Normal', ambient: 'Always', animateMark: false }))
    sessionStorage.setItem('e2e-seeded', '1')
  })
  await page.goto('/?demo' + hash)
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
}

test('S1: Today shows what needs you', async ({ page }) => {
  await start(page)
  await expect(page.getByText('6 things need you. A fix is drafted for each.')).toBeVisible()
})

test('S2: Settings opens on General', async ({ page }) => {
  await start(page)
  // On a phone the account menu lives in the drawer; on desktop the sidebar is always there.
  const menuButton = page.getByRole('button', { name: 'Menu' })
  if (await menuButton.isVisible()) await menuButton.click()
  const side = page.getByRole('complementary', { name: 'Sidebar' })
  await side.getByRole('button', { name: /account and settings/i }).click()
  await page.getByRole('menu', { name: 'Account' }).getByRole('menuitem', { name: 'Your settings' }).click()
  await page.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'General' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'General' })).toBeVisible()
})
