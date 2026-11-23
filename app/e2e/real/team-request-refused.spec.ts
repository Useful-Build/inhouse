// The team window on the test build: the product has no route for a team request yet, so the client refuses it. It
// would fail if the window still said "Request sent", closed, cleared what was typed, or promised a reply time.
import { expect, test } from '../support/test-build/index.js'
import { open, signInAs } from '../support/clients/real.js'

test('A refused team request keeps the window open with the draft and says it was not sent', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await open(page, 'admin', '#/today')
  // On a phone the sidebar is a drawer behind the Menu button.
  if ((page.viewportSize()?.width ?? 1440) < 600) await page.getByRole('button', { name: 'Menu' }).click()
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: /account and settings/i }).click()
  await page.getByRole('menu', { name: 'Account' }).getByRole('menuitem', { name: /^Your Inhouse team/ }).click()

  const team = page.getByRole('dialog', { name: 'Your Inhouse team' })
  const subject = 'Connect our Faire wholesale account'
  await team.getByRole('textbox', { name: 'Title' }).fill(subject)
  await team.getByRole('button', { name: 'Send to the team' }).click()

  await expect(team.getByRole('alert')).toContainText("Your request wasn't sent.")
  await expect(team).toBeVisible()
  await expect(team.getByRole('textbox', { name: 'Title' })).toHaveValue(subject)
  await expect(page.locator('[data-toast]').filter({ hasText: /Request sent|replies within/ })).toHaveCount(0)
})
