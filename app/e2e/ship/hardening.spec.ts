// Ship spec for the hardening project: the 84 KB icon font, lazy pages, deep links and the per-screen crash boundary.
// Recorded at 1440x900 and 390x844. Every page is opened through the UI, as a person would.
import { expect, test } from '../csp.js'
import type { Locator, Page } from '@playwright/test'

const phone = () => test.info().project.name === 'ship-phone'

/** Seeds the demo once per browser session, then loads `url` as a first visit (a full load, not a hash change). */
async function start(page: Page, url: string, heading: string | RegExp) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-seeded')) return
    localStorage.clear()
    localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: 'Act', scenario: 'Normal', ambient: 'Always', animateMark: false }))
    sessionStorage.setItem('e2e-seeded', '1')
  })
  await page.goto(url)
  if (heading) await expect(h1(page, heading)).toBeVisible()
}

const main = (page: Page) => page.getByRole('main')
const h1 = (page: Page, name: string | RegExp) => page.getByRole('heading', { level: 1, name, exact: typeof name === 'string' })
/** Today's heading greets the person ("Good morning, Sam. ..."), not the page name. */
const TODAY = /^Good (morning|afternoon|evening)/
/** Library opens on its All files view. */
const LIBRARY = 'All files'
const team = (page: Page) => page.getByRole('dialog', { name: 'Your Inhouse team' })
const toast = (page: Page, text: string) => page.locator('[data-toast]').filter({ hasText: text })

/** The sidebar. On a phone it is a drawer behind the Menu button, so it is opened first. */
async function sidebar(page: Page) {
  if (phone()) await page.getByRole('button', { name: 'Menu' }).click()
  const side = page.getByRole('complementary', { name: 'Sidebar' })
  await expect(side).toBeVisible()
  return side
}

async function goTo(page: Page, name: string, heading: string | RegExp = name === 'Today' ? TODAY : name) {
  const side = await sidebar(page)
  await side.getByRole('button', { name, exact: true }).click()
  await expect(h1(page, heading)).toBeVisible()
}

async function accountItem(page: Page, name: string) {
  const side = await sidebar(page)
  await side.getByRole('button', { name: /account and settings/i }).click()
  await page.getByRole('menu', { name: 'Account' }).getByRole('menuitem', { name, exact: true }).click()
}

async function pickPage(page: Page, name: string) {
  const back = page.getByRole('button', { name: 'Back to settings' })
  if (await back.isVisible()) await back.click()
  await page.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name, exact: true }).click()
  await expect(h1(page, name)).toBeVisible()
}

/** Icons are drawn by ligature: when the font fails, the icon's name shows as text and the glyph box grows far past its size. */
async function expectIconsDrawn(scope: Locator, atLeast = 3) {
  const icons = scope.locator('.ms')
  const shown = await icons.evaluateAll(els => els.filter(e => (e as HTMLElement).getBoundingClientRect().width > 0).map(e => {
    const el = e as HTMLElement
    return { name: el.textContent ?? '', width: el.getBoundingClientRect().width, size: parseFloat(getComputedStyle(el).fontSize) }
  }))
  expect(shown.length).toBeGreaterThanOrEqual(atLeast)
  expect(shown.filter(i => i.width > i.size * 1.6), 'icons drawn as text').toEqual([])
  // Outside the icons, no visible text reads as an icon name (folder_open, task_alt): a glyph never shows its letters.
  const leaked = await scope.evaluate(root => {
    const out: string[] = []
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const text = n.textContent?.trim() ?? ''
      const el = n.parentElement
      if (!el || el.closest('.ms') || !/^[a-z]+(_[a-z]+)+$/.test(text)) continue
      if (el.getBoundingClientRect().width > 0) out.push(text)
    }
    return out
  })
  expect(leaked, 'icon names shown as text').toEqual([])
}

async function paletteTheme(page: Page, to: 'dark' | 'light') {
  await page.keyboard.press('ControlOrMeta+K')
  const option = page.getByRole('option', { name: new RegExp(`Switch to ${to} theme`) })
  await expect(option).toBeVisible()
  await option.click()
  await expect(page.locator('html')).toHaveClass(to === 'dark' ? /\bdark\b/ : /^((?!\bdark\b).)*$/)
}

test('S1: Icons draw the same after the font was cut to 84 KB: Today, sidebar, Library, a toast, dark and back', async ({ page }) => {
  await start(page, '/?demo#/today', TODAY)
  await expect.poll(() => page.evaluate(() => document.fonts.check("20px 'Material Symbols Rounded'"))).toBe(true)
  await expectIconsDrawn(main(page), 1)
  const side = await sidebar(page)
  await expectIconsDrawn(side, 5)
  await side.getByRole('button', { name: 'Library', exact: true }).click()
  await expect(h1(page, LIBRARY)).toBeVisible()
  await expectIconsDrawn(main(page), 1)
  // A toast: forgetting a memory line shows one with its own icon.
  await accountItem(page, 'Your settings')
  await pickPage(page, 'Memory')
  await main(page).getByRole('button', { name: 'Forget', exact: true }).first().click()
  const forgotten = toast(page, 'Forgotten. Your Inhouse agent will no longer use this.')
  await expect(forgotten).toBeVisible()
  // Pointing at the toast holds it, as it would for a person reading it, so it stays while it's checked.
  await forgotten.hover()
  await expectIconsDrawn(forgotten, 1)
  // Dark and back: the icons still draw.
  await paletteTheme(page, 'dark')
  await expectIconsDrawn(main(page), 1)
  await paletteTheme(page, 'light')
  await expectIconsDrawn(main(page), 1)
})

test('S2: Heavy pages load on first visit without a crash, with the heading in focus and the tab titled', async ({ page }) => {
  await start(page, '/?demo#/today', TODAY)
  await goTo(page, 'Usage')
  await expect(page).toHaveTitle(/Usage/)
  if (!phone()) await expect(h1(page, 'Usage')).toBeFocused()
  await goTo(page, 'Library', LIBRARY)
  await expect(page).toHaveTitle(/Library/)
  if (!phone()) await expect(h1(page, LIBRARY)).toBeFocused()
  await accountItem(page, 'Your settings')
  // Settings shows its own title on a phone (the menu) and the first tab's on a desktop.
  const settings = h1(page, phone() ? 'Settings' : 'General')
  await expect(settings).toBeVisible()
  await expect(page).toHaveTitle(/Settings|General/)
  if (!phone()) await expect(settings).toBeFocused()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('S3: A deep link opens straight onto a lazy page, and Back to Today works', async ({ page }) => {
  await start(page, '/?demo#/settings/team-audit', 'Audit log')
  await expect(main(page).getByText('Sam Mercer changed an approval rule', { exact: true })).toBeVisible()
  await goTo(page, 'Today')
  await expect(page).toHaveURL(/#\/today$/)
})

test('S4: A broken screen shows its own error inside the app, and the sidebar and Message the team still work', async ({ page }) => {
  await start(page, '/?demo&crash=screen#/usage', '')
  const crashed = main(page).getByRole('alert')
  await expect(crashed.getByRole('heading', { name: 'Something went wrong.' })).toBeVisible()
  await expect(crashed.getByRole('button', { name: 'Try again', exact: true })).toBeVisible()
  // The sidebar still works: it moves to Today (the crash switch breaks every screen, so Today shows the same message).
  const side = await sidebar(page)
  await side.getByRole('button', { name: 'Today', exact: true }).click()
  await expect(page).toHaveURL(/#\/today$/)
  // On a phone the drawer closes after a pick; on desktop the sidebar stays.
  if (!phone()) await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible()
  await expect(main(page).getByRole('alert')).toBeVisible()
  // Message the team opens the team window on Report a bug, with a line about the crash.
  await main(page).getByRole('button', { name: 'Message the team', exact: true }).click()
  await expect(team(page)).toBeVisible()
  await expect(team(page).getByRole('radio', { name: /Report a bug/ })).toBeChecked()
  await expect(team(page).getByRole('textbox', { name: 'Your request' })).toHaveValue(/screen crashed and showed "Something went wrong\."/)
})
