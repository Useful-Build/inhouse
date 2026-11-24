// The team window on the test build: a request goes to the server (route 81) and shows under Your requests. It would
// fail if the window kept the draft after the server took it, promised a reply time the team hasn't set, or listed
// nothing after the send.
import { expect, test } from '../support/test-build/index.js'
import { open, signInAs } from '../support/clients/real.js'

test('A team request is sent, says so without a reply time, and shows under Your requests', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await open(page, 'admin', '#/today')
  const openTeam = async () => {
    // On a phone the sidebar is a drawer behind the Menu button.
    if ((page.viewportSize()?.width ?? 1440) < 600) await page.getByRole('button', { name: 'Menu' }).click()
    await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: /account and settings/i }).click()
    await page.getByRole('menu', { name: 'Account' }).getByRole('menuitem', { name: /^Your Inhouse team/ }).click()
  }
  await openTeam()

  const team = page.getByRole('dialog', { name: 'Your Inhouse team' })
  // A title of its own per run and project, so the list check finds this request and no other.
  const subject = `Connect our Faire account ${test.info().project.name} ${Date.now()}`
  await team.getByRole('textbox', { name: 'Title' }).fill(subject)
  await team.getByRole('button', { name: 'Send to the team' }).click()

  await expect(page.locator('[data-toast]').filter({ hasText: 'Request sent to your Inhouse team.' })).toBeVisible()
  await expect(page.locator('[data-toast]').filter({ hasText: /replies within/ })).toHaveCount(0)
  await expect(team).toBeHidden()

  await openTeam()
  await team.getByRole('radio', { name: /^Your requests/ }).click()
  await expect(team.getByRole('list', { name: 'Open requests' }).getByRole('listitem').filter({ hasText: subject })).toContainText('With the team')
})
