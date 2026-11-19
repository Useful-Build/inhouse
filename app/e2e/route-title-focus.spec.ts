// Route titles, focus on the page heading and the lazy routes (desktop). Production plan H3: P-2, A-10.
import { expect, test } from '@playwright/test'
import { routeTitleFocusTests } from './route-title-focus.js'

routeTitleFocusTests(false)

// An old tab opening a lazy route after a deploy: its chunk is gone, so the tab reloads once and the draft survives.
test('A lazy chunk that fails to load reloads the tab once and keeps the composer draft', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-seeded')) return
    localStorage.clear()
    localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: 'Act', scenario: 'Normal', ambient: 'Always', animateMark: false }))
    sessionStorage.setItem('e2e-seeded', '1')
  })
  let loads = 0
  page.on('load', () => { loads++ })
  await page.goto('/?demo#/today')
  const composer = page.getByRole('textbox', { name: /^(Ask|Message) your Inhouse agent$/ })
  await composer.fill('A question I had half typed')

  // From now on the first script request fails, like a chunk the new deploy deleted.
  let failed = 0
  await page.route(/\/assets\/.*\.js(\?.*)?$/, route => {
    if (failed === 0) { failed++; return route.abort() }
    return route.continue()
  })
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Usage' }).click()

  await expect(page.getByRole('heading', { level: 1, name: 'Usage' })).toBeVisible()
  expect(failed).toBe(1)
  expect(loads, 'the first load and one reload').toBe(2)

  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Today' }).click()
  await expect(composer).toHaveValue('A question I had half typed')
})
