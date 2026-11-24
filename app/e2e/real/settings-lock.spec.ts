// UI plan 3, the Settings menu on the test build: brand settings carry a lock on their section's heading for anyone who
// can't change them (`me().can.editBrandSettings`), with the reason in a tooltip; an Admin sees no lock. It would fail
// if a Member's menu dropped the lock, showed it on their own section, or an Admin saw one.
import { expect, test } from '../support/test-build/index.js'
import { open, signInAs } from '../support/clients/real.js'

// The product's limits section holds only the Spending cap and Pause, so it is called Spending (the demo keeps "Approvals and limits").
const TEAM_SECTIONS = ['Agent', 'Spending', 'Team', 'Workspace']
const phone = (w: number | undefined) => (w ?? 1440) < 600

test('A Member sees a lock with "Admins change these" on every team section, and none on You', async ({ page, context }) => {
  await signInAs(context, 'dana')
  // On a phone the menu is the Settings screen itself; on desktop it sits beside a page.
  await open(page, 'dana', phone(page.viewportSize()?.width) ? '#/settings' : '#/settings/you-general')
  const nav = page.getByRole('navigation', { name: 'Settings' })
  await expect(nav.getByRole('group', { name: 'You' })).toBeVisible()
  await expect(nav.getByRole('group', { name: 'You' }).getByRole('button', { name: 'Admins change these' })).toHaveCount(0)
  for (const name of TEAM_SECTIONS) {
    await expect(nav.getByRole('group', { name }).getByRole('button', { name: 'Admins change these' })).toHaveCount(1)
  }
  if (!phone(page.viewportSize()?.width)) {
    await nav.getByRole('group', { name: 'Agent' }).getByRole('button', { name: 'Admins change these' }).hover()
    await expect(page.getByRole('tooltip')).toHaveText('Admins change these')
  }
})

test('An Admin sees no lock in the Settings menu', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await open(page, 'admin', phone(page.viewportSize()?.width) ? '#/settings' : '#/settings/you-general')
  const nav = page.getByRole('navigation', { name: 'Settings' })
  await expect(nav.getByRole('group', { name: 'Workspace' })).toBeVisible()
  await expect(nav.getByRole('button', { name: 'Admins change these' })).toHaveCount(0)
})
