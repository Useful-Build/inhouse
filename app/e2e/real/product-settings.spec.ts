// The product's Settings on the test build (the product bundle, a signed-in Admin): what it leaves out because nothing reads
// it yet, where Pause and the Brand name live, and where a link to a page the product doesn't have lands. It would fail if
// the product showed Language, Text size or Two-step sign-in again, kept Who approves what or Run limits reachable by a
// link, lost the Pause button from the Spending cap page, or showed an empty brand name (the sidebar's subtitle and the
// Brand name row come from the seeded `b:name` setting).
import { expect, test } from '../support/test-build/index.js'
import { open, signInAs } from '../support/clients/real.js'
import { SEED_SETTINGS } from '../../server/seed/brand.ts'

const BRAND = String(SEED_SETTINGS.find(([, key]) => key === 'b:name')![2])
const phone = (w: number | undefined) => (w ?? 1440) < 600

test('General and Data and access leave out Language, Text size and Two-step sign-in', async ({ page, context }) => {
  await signInAs(context, 'admin')
  const main = page.getByRole('main')
  await open(page, 'admin', '#/settings/you-general')
  await expect(page.getByRole('heading', { level: 1, name: 'General', exact: true })).toBeVisible()
  await expect(main.getByText('Theme', { exact: true })).toBeVisible()
  for (const hidden of ['Language', 'Text size']) await expect(main.getByText(hidden, { exact: true })).toHaveCount(0)
  await open(page, 'admin', '#/settings/team-data')
  await expect(page.getByRole('heading', { level: 1, name: 'Data and access', exact: true })).toBeVisible()
  await expect(main.getByText('Inhouse team access', { exact: true })).toBeVisible()
  await expect(main.getByText('Two-step sign-in', { exact: true })).toHaveCount(0)
})

test('The Inhouse agent page shows the seeded brand name and leaves out Tone and Signs emails as', async ({ page, context }) => {
  await signInAs(context, 'admin')
  const main = page.getByRole('main')
  await open(page, 'admin', '#/settings/team-agent')
  await expect(page.getByRole('heading', { level: 1, name: 'Inhouse agent', exact: true })).toBeVisible()
  await expect(main.getByText('Brand name', { exact: true })).toBeVisible()
  // A phone reads a team page as text; a desktop Admin edits it in a field.
  if (phone(page.viewportSize()?.width)) await expect(main.getByText(BRAND, { exact: true })).toBeVisible()
  else {
    await expect(main.getByRole('textbox', { name: 'Brand name', exact: true })).toHaveValue(BRAND)
    await expect(page.getByRole('complementary', { name: 'Sidebar' }).getByText(BRAND, { exact: true })).toBeVisible()
  }
  for (const hidden of ['Tone', 'Signs emails as']) await expect(main.getByText(hidden, { exact: true })).toHaveCount(0)
})

test('Spending cap holds Pause Inhouse agent, and the menu has no Who approves what, Run limits or Notifications', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await open(page, 'admin', '#/settings/team-spend')
  await expect(page.getByRole('heading', { level: 1, name: 'Spending cap', exact: true })).toBeVisible()
  // At Watch the Act-stage button is shown and locked (it works from Act).
  await expect(page.getByRole('main').getByRole('button', { name: 'Pause Inhouse agent', exact: true })).toBeDisabled()
  if (phone(page.viewportSize()?.width)) await page.getByRole('button', { name: 'Back to settings' }).click()
  const nav = page.getByRole('navigation', { name: 'Settings' })
  await expect(nav.getByRole('button', { name: 'Spending cap', exact: true })).toBeVisible()
  for (const gone of ['Who approves what', 'Run limits', 'Notifications']) await expect(nav.getByRole('button', { name: gone, exact: true })).toHaveCount(0)
})

for (const tab of ['team-approvals', 'team-limits', 'you-notif']) {
  test(`A link to ${tab} lands on General and says the page doesn't exist`, async ({ page, context }) => {
    await signInAs(context, 'admin')
    await open(page, 'admin', `#/settings/${tab}`)
    await expect(page.getByRole('heading', { level: 1, name: 'General', exact: true })).toBeVisible()
    await expect(page.locator('[data-toast]').filter({ hasText: "That page doesn't exist. You're on General." })).toBeVisible()
  })
}
