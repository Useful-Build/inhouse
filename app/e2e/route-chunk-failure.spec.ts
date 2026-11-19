// A lazy route's chunk failing to load (an old tab after a deploy) and focus staying put on in-page hash changes (desktop).
// Production plan H3: P-2, A-10.
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const CHUNK = /\/assets\/Usage-[^/]*\.js(\?.*)?$/
const CRASH = 'inhouse.e2e.crash-seen'

/** Seeds the demo once per tab, and records in sessionStorage (so it survives a reload) every moment the crash screen was in the DOM. */
async function start(page: Page, hash: string) {
  await page.addInitScript(crashKey => {
    new MutationObserver(() => {
      if ([...document.querySelectorAll('h1')].some(h => h.textContent === 'Something went wrong.')) sessionStorage.setItem(crashKey, '1')
    }).observe(document, { childList: true, subtree: true, characterData: true })
    if (sessionStorage.getItem('e2e-seeded')) return
    localStorage.clear()
    localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: 'Act', scenario: 'Normal', ambient: 'Always', animateMark: false }))
    sessionStorage.setItem('e2e-seeded', '1')
  }, CRASH)
  await page.goto('/?demo' + hash)
}
const crashSeen = (page: Page) => page.evaluate(k => sessionStorage.getItem(k) === '1', CRASH)
const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' })
const crashHeading = (page: Page) => page.getByRole('heading', { level: 1, name: 'Something went wrong.' })

test('A lazy chunk that fails once reloads into the route, keeps the draft and never shows the crash screen', async ({ page }) => {
  await start(page, '#/today')
  const composer = page.getByRole('textbox', { name: /^(Ask|Message) your Inhouse agent$/ })
  await composer.fill('A question I had half typed')

  let failed = 0
  await page.route(CHUNK, route => {
    if (failed === 0) { failed++; return route.abort() }
    return route.continue()
  })
  await sidebar(page).getByRole('button', { name: 'Usage' }).click()

  await expect(page.getByRole('heading', { level: 1, name: 'Usage' })).toBeVisible()
  expect(failed).toBe(1)
  await expect(crashHeading(page)).toHaveCount(0)
  expect(await crashSeen(page), 'the crash screen was never in the page').toBe(false)

  await sidebar(page).getByRole('button', { name: 'Today' }).click()
  await expect(composer).toHaveValue('A question I had half typed')
})

test('A second chunk failure inside the guard window reaches the error screen instead of looping', async ({ page }) => {
  await start(page, '#/today')
  let loads = 0
  page.on('load', () => { loads++ })
  await page.route(CHUNK, route => route.abort())
  await sidebar(page).getByRole('button', { name: 'Usage' }).click()

  await expect(crashHeading(page)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reload', exact: true })).toBeVisible()
  // The first failure reloaded once (two loads in all); the second didn't reload again.
  expect(loads).toBe(1)
})

test('In-page hash changes leave focus where the person put it', async ({ page }) => {
  await start(page, '#/chats/all')
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
  const moved = () => page.evaluate(() => {
    const a = document.activeElement
    return !!a && (a.id === 'main' || (a.tagName === 'H1' && !!a.closest('main')))
  })

  // Opening a chat.
  const row = sidebar(page).locator('[data-chat-row]').first()
  await row.click()
  await expect(page).toHaveURL(/#\/chats\/(?!all)/)
  expect(await moved(), 'opening a chat moved focus to the page').toBe(false)

  // Switching a settings tab (opening Settings itself is a route change and does move focus).
  await sidebar(page).getByRole('button', { name: /account and settings/i }).click()
  await page.getByRole('menu', { name: 'Account' }).getByRole('menuitem', { name: 'Your settings', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Settings' })).toBeVisible()
  const tab = page.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'Notifications' })
  await tab.focus()
  await tab.click()
  await expect(page).toHaveURL(/#\/settings\/you-notif/)
  await expect(tab).toBeFocused()

  // Opening a Library file.
  await sidebar(page).getByRole('button', { name: 'Library' }).click()
  await expect(page.getByRole('list', { name: 'Files' })).toBeVisible()
  await page.getByRole('list', { name: 'Files' }).getByRole('listitem').first().click()
  await expect(page).toHaveURL(/#\/library\/./)
  expect(await moved(), 'opening a file moved focus to the page').toBe(false)
})
