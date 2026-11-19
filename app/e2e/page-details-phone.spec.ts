// Page actions at 390 px: Settings shows its menu, then a page with Back (the app's and the browser's); the Library's filter sheet
// holds the sort and the type.
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { atRest } from './states.js'

async function start(page: Page, hash: string) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-seeded')) return
    localStorage.clear()
    localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: 'Act', scenario: 'Normal', ambient: 'Always', animateMark: false }))
    sessionStorage.setItem('e2e-seeded', '1')
  })
  await page.goto('/?demo' + hash)
}
const shot = async (page: Page, name: string) => { await atRest(page); await page.screenshot({ path: test.info().outputPath(`${name}.png`) }) }
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
  await expect(page.getByRole('note')).toContainText('Change these on a computer.')
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

test('Phone: the Library filter sheet sorts and picks a type, and any type can be picked', async ({ page }) => {
  await start(page, '#/library')
  await expect(page.getByRole('heading', { level: 1, name: 'All files' })).toBeVisible()
  const rows = page.getByRole('list', { name: 'Files' }).getByRole('listitem')
  const total = await rows.count()
  const filters = page.getByRole('button', { name: /^Filters/ })
  await filters.click()
  const sheet = page.getByRole('dialog', { name: 'Filter files' })
  await expect(sheet).toBeVisible()
  expect(await noSideways(page)).toBe(true)
  await shot(page, '390-library-filters')
  // Sort by name, and the last type.
  // The chips are drawn at 32px, each with a tap area at least 44px tall.
  for (const chip of [sheet.getByRole('radio', { name: 'Name' }), sheet.getByRole('radio', { name: /^Other \d+$/ })]) {
    expect(await chip.evaluate(e => parseFloat(getComputedStyle(e, '::after').height)), 'tap area height').toBeGreaterThanOrEqual(44)
  }
  await sheet.getByRole('radio', { name: 'Name' }).click()
  const other = sheet.getByRole('radio', { name: /^Other \d+$/ })
  const n = Number((await other.innerText()).replace(/\D/g, ''))
  await other.click()
  await expect(other).toHaveAttribute('aria-checked', 'true')
  await sheet.getByRole('button', { name: 'Done' }).click()
  await expect(sheet).toHaveCount(0)
  await expect(rows).toHaveCount(n)
  expect(n).toBeLessThan(total)
  // The button counts what is set, and focus came back to it.
  await expect(filters).toContainText('2')
  await expect(filters).toBeFocused()
  const names = (await rows.locator('xpath=.//span[contains(@class,"font-strong")]').allInnerTexts()).map(t => t.toLowerCase())
  expect(names, 'sorted by name').toEqual([...names].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })))
  expect(await noSideways(page)).toBe(true)
  await shot(page, '390-library-other-tab')

  // Each row's menu shows without hover on a phone.
  const first = rows.first()
  await expect(first.getByRole('button', { name: /^Actions for / })).toHaveCSS('opacity', '1')
})
