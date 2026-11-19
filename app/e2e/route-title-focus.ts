// Shared by route-title-focus.spec.ts (desktop) and route-title-focus-phone.spec.ts (390 px): the document title per
// route, focus on the page's h1 after a route change (not on first load), a lazy route opening, and a deep link to one.
import { expect, test } from './csp.js'
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

export function routeTitleFocusTests(phone: boolean) {
  /** Open a page from the sidebar by its name, the way a person does: on a phone through the Menu drawer, on desktop by keyboard. */
  async function open(page: Page, name: string) {
    if (phone) await page.getByRole('button', { name: 'Menu' }).click()
    const item = page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name })
    if (phone) await item.click()
    else {
      await item.focus()
      await page.keyboard.press('Enter')
    }
  }
  /** Settings isn't in the sidebar's nav: a person opens it from the account menu. */
  async function openSettings(page: Page) {
    if (phone) await page.getByRole('button', { name: 'Menu' }).click()
    await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: /account and settings/i }).click()
    await page.getByRole('menu', { name: 'Account' }).getByRole('menuitem', { name: 'Your settings', exact: true }).click()
  }
  const h1 = (page: Page, name: string | RegExp) => page.getByRole('heading', { level: 1, name })

  test('First load sets the title and leaves focus alone; a route change names the page and focuses its h1', async ({ page }) => {
    await start(page, '#/today')
    await expect(h1(page, /./)).toBeVisible()
    await expect(page).toHaveTitle('Today · Inhouse')
    await expect(page.locator('h1').first()).not.toBeFocused()

    await open(page, 'Usage')
    await expect(page).toHaveTitle('Usage · Inhouse')
    await expect(h1(page, 'Usage')).toBeFocused()

    await open(page, 'Library')
    await expect(page).toHaveTitle('Library · Inhouse')
    await expect(page.locator('main h1').first()).toBeFocused()

    await openSettings(page)
    await expect(page).toHaveTitle(/ · Inhouse$/)
    await expect(page).not.toHaveTitle('Library · Inhouse')
    await expect(page.locator('main h1').first()).toBeFocused()

    await page.goBack()
    await page.goBack()
    await expect(page).toHaveTitle('Usage · Inhouse')
    await expect(h1(page, 'Usage')).toBeFocused()
  })

  test('A lazy route loads a chunk of its own when opened', async ({ page }) => {
    await start(page, '#/today')
    await expect(h1(page, /./)).toBeVisible()
    // Vite names a lazy chunk after its module: assets/Usage-<hash>.js.
    const usageChunk = page.waitForRequest(r => /\/assets\/Usage-[^/]*\.js$/.test(r.url()))
    await open(page, 'Usage')
    await usageChunk
    await expect(h1(page, 'Usage')).toBeVisible()
  })

  test('A deep link to a lazy route loads it directly', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    await start(page, '#/usage')
    await expect(h1(page, 'Usage')).toBeVisible()
    await expect(page).toHaveTitle('Usage · Inhouse')
    // A first load doesn't move focus.
    await expect(h1(page, 'Usage')).not.toBeFocused()
    expect(errors).toEqual([])
  })
}
