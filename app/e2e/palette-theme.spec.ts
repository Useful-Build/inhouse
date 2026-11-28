// The theme switch: the ⌘K palette's "Switch to dark/light theme" item and Settings > General > Theme (the only place
// to pick System). Each choice sets the root `dark` class and the page colour, saves in the app's theme preference (System saves
// nothing and follows `prefers-color-scheme`) and survives a reload.
import { expect, test, type Fx } from './support/fx.js'
import type { Page } from '@playwright/test'

async function start(page: Page, fx: Fx, scheme: 'light' | 'dark', hash = '#/today') {
  // The OS setting for the run. No saved theme: the app follows it.
  await page.emulateMedia({ colorScheme: scheme })
  await fx.seed({})
  await page.goto('/?demo' + hash)
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
}

const palette = (page: Page) => page.getByRole('dialog', { name: 'Search' })
const saved = async (fx: Fx) => (await fx.saved()).theme
/** What the page shows: the root class and the body's computed background, as a 0 to 1 brightness. */
const look = (page: Page) => page.evaluate(() => {
  const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g)!.slice(0, 3).map(Number)
  return { dark: document.documentElement.classList.contains('dark'), brightness: (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 }
})

/** A dark page has a dark body, a light page a light one: the class and the colour agree. */
async function expectTheme(page: Page, theme: 'light' | 'dark') {
  await expect.poll(async () => {
    const l = await look(page)
    return l.dark === (theme === 'dark') && (theme === 'dark' ? l.brightness < 0.2 : l.brightness > 0.8)
  }, { message: `the root class and the body colour show ${theme}` }).toBe(true)
}

/** Opens ⌘K and runs the theme item with this name. */
async function paletteTheme(page: Page, item: 'Switch to dark theme' | 'Switch to light theme') {
  await page.keyboard.press('ControlOrMeta+k')
  await expect(palette(page)).toBeVisible()
  await palette(page).getByRole('option', { name: item }).click()
  await expect(palette(page)).toHaveCount(0)
}

test('Palette: the theme item flips light and dark, sets the page colour, is saved and survives a reload', async ({ fx, page }) => {
  await start(page, fx, 'light')
  await expectTheme(page, 'light')
  expect(await saved(fx)).toBeUndefined()

  // From light the item offers dark, and only dark.
  await page.keyboard.press('ControlOrMeta+k')
  await expect(palette(page).getByRole('option', { name: 'Switch to dark theme' })).toBeVisible()
  await expect(palette(page).getByRole('option', { name: 'Switch to light theme' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  await paletteTheme(page, 'Switch to dark theme')
  await expectTheme(page, 'dark')
  expect(await saved(fx)).toBe('dark')
  await page.reload()
  await expectTheme(page, 'dark')
  expect(await saved(fx)).toBe('dark')

  // From dark the item offers light. The OS still says light: the saved choice wins over it.
  await paletteTheme(page, 'Switch to light theme')
  await expectTheme(page, 'light')
  expect(await saved(fx)).toBe('light')
  await page.reload()
  await expectTheme(page, 'light')
  expect(await saved(fx)).toBe('light')
})

test('Settings: Theme picks Light, Dark and System; System follows the OS setting live and after a reload', async ({ fx, page }) => {
  await start(page, fx, 'light', '#/settings/you-general')
  const theme = (value: string) => page.getByRole('combobox', { name: `Theme: ${value}` })
  const pick = async (from: string, to: string) => {
    await theme(from).click()
    await page.getByRole('listbox', { name: 'Theme' }).getByRole('option', { name: to, exact: true }).click()
    await expect(theme(to)).toBeVisible()
  }
  await expect(theme('System')).toBeVisible()
  await expectTheme(page, 'light')

  await pick('System', 'Dark')
  await expectTheme(page, 'dark')
  expect(await saved(fx)).toBe('dark')
  await page.reload()
  await expect(theme('Dark')).toBeVisible()
  await expectTheme(page, 'dark')

  await pick('Dark', 'Light')
  await expectTheme(page, 'light')
  expect(await saved(fx)).toBe('light')

  // System saves nothing and follows the OS: it changes when the OS does, and a reload keeps following it.
  await pick('Light', 'System')
  expect(await saved(fx)).toBeUndefined()
  await expectTheme(page, 'light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expectTheme(page, 'dark')
  await page.reload()
  await expect(theme('System')).toBeVisible()
  await expectTheme(page, 'dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await expectTheme(page, 'light')

  // A fixed choice ignores the OS.
  await page.emulateMedia({ colorScheme: 'dark' })
  await expectTheme(page, 'dark')
  await pick('System', 'Light')
  await expectTheme(page, 'light')
})
