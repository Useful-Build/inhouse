// Account menu on a phone (390 px): an item that closes the drawer never leaves focus on the page body or on a button
// in the closed drawer. It goes to the page's heading when the route changes, otherwise to the Menu button.
import { expect, test } from './csp.js'

const cases = [
  { from: '#/today', item: 'Sign out', focused: { role: 'button', name: 'Menu' } },
  { from: '#/settings', item: 'Your settings', focused: { role: 'button', name: 'Menu' } },
  { from: '#/today', item: 'Your settings', focused: { role: 'heading', name: 'Settings' } },
] as const

for (const { from, item, focused } of cases) {
  test(`${item} picked on ${from.slice(2)} leaves focus on the ${focused.name} ${focused.role}`, async ({ page }) => {
    await page.goto(`/?demo${from}`)
    await page.getByRole('button', { name: 'Menu' }).click()
    const side = page.getByRole('complementary', { name: 'Sidebar' })
    await side.getByRole('button', { name: /account and settings/i }).click()
    await page.getByRole('menu', { name: 'Account' }).getByRole('menuitem', { name: item, exact: true }).click()
    await expect(side).toBeHidden()
    await expect(page.getByRole(focused.role, { name: focused.name, exact: true })).toBeFocused()
  })
}
