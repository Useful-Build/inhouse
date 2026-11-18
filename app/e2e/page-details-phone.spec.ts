// Page actions at 390 px: Settings shows its menu, then a page with Back (the app's and the browser's); the Library's type tabs
// scroll inside their row and any type can be picked.
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

async function start(page: Page, hash: string) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-seeded')) return
    localStorage.clear()
    localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: 'Act', scenario: 'Normal', ambient: 'Always', animateMark: false }))
    sessionStorage.setItem('e2e-seeded', '1')
  })
  await page.goto('/?demo' + hash)
}
const shot = async (page: Page, name: string) => { await page.waitForTimeout(300); await page.screenshot({ path: test.info().outputPath(`${name}.png`) }) }
const noSideways = (page: Page) => page.evaluate(() => [document.documentElement, document.querySelector('main')!].every(e => e.scrollWidth - e.clientWidth <= 1))

test('Phone: Settings opens on its menu, a page replaces it, and Back returns to the menu', async ({ page }) => {
  await start(page, '#/today')
  await page.getByRole('button', { name: 'Menu' }).click()
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: /account and settings/i }).click()
  await page.getByRole('menu', { name: 'Account' }).getByRole('menuitem', { name: 'Team settings' }).click()

  // The menu alone.
  const nav = page.getByRole('navigation', { name: 'Settings' })
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  await expect(nav.getByRole('button', { name: 'Spending cap' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: 'Stage and plan' })).toHaveCount(0)
  expect(await noSideways(page)).toBe(true)
  await shot(page, '390-settings-menu')
  // Menu rows are at least 44 px tall.
  const h = await nav.locator('button[data-nav-row]').first().evaluate(e => e.getBoundingClientRect().height)
  expect(h).toBeGreaterThanOrEqual(44)

  // A page alone, with Back.
  await nav.getByRole('button', { name: 'Spending cap' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Spending cap' })).toBeVisible()
  await expect(nav).toHaveCount(0)
  // Team settings are read on a phone: the cap shows as text.
  await expect(page.getByRole('textbox', { name: 'Monthly cap' })).toHaveCount(0)
  await expect(page.getByRole('note')).toContainText('Change team settings on a computer')
  await expect(page.locator('main')).toContainText('$250')
  expect(await page.locator('main').evaluate(e => e.scrollTop)).toBe(0)
  expect(await noSideways(page)).toBe(true)
  await shot(page, '390-settings-page')
  // The browser's Back returns to the menu, not out of Settings; Forward opens the page again.
  await page.goBack()
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  await expect(nav.getByRole('button', { name: 'Spending cap' })).toBeVisible()
  await page.goForward()
  await expect(page.getByRole('heading', { level: 1, name: 'Spending cap' })).toBeVisible()
  // The page's own Back button steps back to the menu: it adds no history entry.
  const entries = await page.evaluate(() => history.length)
  await page.getByRole('button', { name: 'Back to settings' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  expect(await page.evaluate(() => history.length)).toBe(entries)
  // So the browser's Back from the menu leaves Settings (it does not land on the page again).
  await page.goBack()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('things need you')
  await page.goForward()
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  await nav.getByRole('button', { name: 'Spending cap' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Spending cap' })).toBeVisible()
  await page.getByRole('button', { name: 'Back to settings' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()

  // Search on the menu, then a found page.
  await page.getByRole('searchbox', { name: 'Search settings' }).fill('language')
  await nav.getByRole('button', { name: /General/ }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'General' })).toBeVisible()

  // A link to a settings page opens that page, not the menu.
  await page.evaluate(() => { location.hash = '#/today' })
  await expect(page.getByRole('heading', { level: 1 })).toContainText('things need you')
  await page.evaluate(() => { location.hash = '#/settings/team-modes' })
  await expect(page.getByRole('heading', { level: 1, name: 'Models' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Back to settings' })).toBeVisible()
})

test('Phone: Library type tabs scroll in their row with a fade, and the last type can be picked', async ({ page }) => {
  await start(page, '#/library')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('All files')
  const tabs = page.getByRole('radiogroup', { name: 'File type' })
  const t = await tabs.evaluate(e => ({ sw: e.scrollWidth, cw: e.clientWidth }))
  expect(t.sw, 'the tabs scroll inside their row').toBeGreaterThan(t.cw)
  // The fade sits at the right edge while more tabs are hidden there.
  const fade = tabs.locator('xpath=following-sibling::span[@aria-hidden="true"]')
  await expect(fade).toHaveCount(1)
  await shot(page, '390-library-tabs-fade')

  const other = tabs.getByRole('radio', { name: /^Other \d+$/ })
  const n = Number((await other.innerText()).replace(/\D/g, ''))
  await other.click()
  await expect(other).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('list', { name: 'Files' }).getByRole('listitem')).toHaveCount(n)
  // Scrolled to the end, the fade goes.
  await tabs.evaluate(e => { e.scrollLeft = e.scrollWidth })
  await expect(fade).toHaveCount(0)
  // Tabs are at least 44 px tall to tap.
  expect(await other.evaluate(e => e.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44)
  expect(await noSideways(page)).toBe(true)
  await shot(page, '390-library-other-tab')

  // Each card's menu shows without hover on a phone.
  const first = page.getByRole('list', { name: 'Files' }).getByRole('listitem').first()
  await expect(first.getByRole('button', { name: /^Actions for / })).toHaveCSS('opacity', '1')
})
