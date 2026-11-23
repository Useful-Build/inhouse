// Route titles, focus on the page heading and the lazy routes (desktop). Production plan H3: P-2, A-10.
import { expect, test } from './support/fx.js'
import { routeTitleFocusTests } from './route-title-focus.js'

routeTitleFocusTests(false)

// An old tab opening a lazy route after a deploy: its chunk is gone, so the tab reloads once and the draft survives.
test('A lazy chunk that fails to load reloads the tab once and keeps the composer draft', async ({ page, fx }) => {
  await fx.seed({ stage: 'Act', demo: { ambient: 'Always' } })
  let loads = 0
  page.on('load', () => { loads++ })
  await page.goto('/?demo#/today')
  const composer = page.getByRole('textbox', { name: /^(Ask|Message) Inhouse$/ })
  await composer.fill('A question I had half typed')

  // From now on the first script request fails, like a chunk the new deploy deleted.
  let failed = 0
  await page.route(/\/assets\/.*\.js(\?.*)?$/, route => {
    if (failed === 0) { failed++; return route.abort() }
    return route.continue()
  })
  // Usage opens from the account menu (it left the sidebar); the menu is in the app's bundle, so the first chunk asked for is still Usage's.
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: /account and settings/i }).click()
  await page.getByRole('menu', { name: 'Account' }).getByRole('menuitem', { name: 'Usage', exact: true }).click()

  await expect(page.getByRole('heading', { level: 1, name: 'Usage' })).toBeVisible()
  expect(failed).toBe(1)
  expect(loads, 'the first load and one reload').toBe(2)

  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Today' }).click()
  await expect(composer).toHaveValue('A question I had half typed')
})
