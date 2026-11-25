// The product hides what only the demo wires (src/lib/product-flow.ts): the composer's Dictate, Attach's "From Google
// Drive" and "Screenshot of this page", and the account menu's Help and guides. Their helpers are plain flags with unit
// tests, so dropping a guard at its call site failed no test (FEATURE_MAP gaps for "Chat: Google Drive and Slack stubs",
// "Chat: Dictate" and "Account menu"). Each hidden item is checked next to one that must show, so an empty or closed menu
// can't pass. The demo shows all of them (e2e/not-connected-stubs.spec.ts, e2e/help-account-menu.spec.ts).
import { expect, test } from '../support/test-build/index.js'
import { open, signInAs } from '../support/clients/real.js'

test("The product's composer and account menu leave out the demo-only items", async ({ page, context }) => {
  await signInAs(context, 'admin')
  await open(page, 'admin', '#/today')
  const phone = (page.viewportSize()?.width ?? 1440) < 600
  const composer = page.locator('[data-composer]')
  await expect(composer).toBeVisible()

  // Dictate sits in the composer's row on a computer (a phone's slim row never has it, in either build).
  if (!phone) {
    await expect(composer.getByRole('button', { name: 'Attach', exact: true })).toBeVisible()
    await expect(composer.getByRole('button', { name: 'Dictate' })).toHaveCount(0)
  }

  // Attach: Upload files, and neither demo stub.
  await composer.getByRole('button', { name: /^Attach/ }).click()
  const attach = page.getByRole('menu')
  await expect(attach.getByRole('menuitem', { name: /Upload files/ })).toBeVisible()
  await expect(attach.getByRole('menuitem', { name: /From Google Drive/ })).toHaveCount(0)
  await expect(attach.getByRole('menuitem', { name: /Screenshot of this page/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(attach).toHaveCount(0)

  // The account menu: Your settings, and no Help and guides.
  if (phone) await page.getByRole('button', { name: 'Menu' }).click()
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: /account and settings/i }).click()
  const account = page.getByRole('menu', { name: 'Account' })
  await expect(account.getByRole('menuitem', { name: 'Your settings' })).toBeVisible()
  await expect(account.getByRole('menuitem', { name: 'Help and guides' })).toHaveCount(0)
})
