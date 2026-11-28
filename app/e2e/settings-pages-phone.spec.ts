// Phone (390): your own Settings pages (Notifications, Memory) keep their controls and a change survives a reload; the
// team pages Inhouse agent, Data and access and Audit log read as text (decision D4) while their buttons still work;
// Help opens from the account menu and fits. The desktop flows are in settings-your-pages.spec.ts,
// settings-agent-data.spec.ts and help-account-menu.spec.ts.
import { expect, test, type Fx } from './support/fx.js'
import type { Page } from '@playwright/test'

async function start(page: Page, fx: Fx, hash: string) {
  await fx.seed({})
  await page.goto('/?demo' + hash)
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
}

const main = (page: Page) => page.getByRole('main')
const h1 = (page: Page, name: string) => page.getByRole('heading', { level: 1, name, exact: true })
/**
 * The settings row with this title and value: the innermost block holding both (no styling classes). `neighbour` is a
 * title that belongs to another row, so a match that grew to the whole card around every row fails.
 */
async function expectRow(page: Page, title: string, value: string | RegExp, neighbour: string) {
  const row = main(page).locator('div').filter({ has: page.getByText(title, { exact: true }) }).filter({ hasText: value }).last()
  await expect(row).toContainText(value)
  await expect(row).not.toContainText(neighbour)
}
const toast = (page: Page, text: string) => page.locator('[data-toast]').filter({ hasText: text })
async function noSidewaysScroll(page: Page) {
  // Polled: right after a resize or a navigation the layout may not have settled yet. A real overflow still fails.
  await expect.poll(() => page.evaluate(() => Math.max(...[document.documentElement, document.querySelector('main')!].map(e => e.scrollWidth - e.clientWidth))),
    { message: 'horizontal overflow in px (page or main)' }).toBeLessThanOrEqual(1)
}

/** On a phone Settings shows its menu first: pick a page from it. */
async function openFromMenu(page: Page, name: string) {
  await page.evaluate(() => { location.hash = '#/settings' })
  await expect(h1(page, 'Settings')).toBeVisible()
  await page.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name, exact: true }).click()
  await expect(h1(page, name)).toBeVisible()
}

test('Phone: Notifications and Memory keep their controls, and a change survives a reload', async ({ fx, page }) => {
  await start(page, fx, '#/today')
  await openFromMenu(page, 'Notifications')
  await expect(page.getByRole('note')).toHaveCount(0)
  const weekly = main(page).getByRole('switch', { name: 'Weekly report', exact: true })
  await expect(weekly).toBeChecked()
  await weekly.click()
  await expect(weekly).not.toBeChecked()
  await main(page).getByRole('combobox', { name: 'Approvals waiting: Right away', exact: true }).click()
  await page.getByRole('option', { name: 'Once an hour' }).click()
  await expect(main(page).getByRole('combobox', { name: 'Approvals waiting: Once an hour', exact: true })).toBeVisible()
  await noSidewaysScroll(page)

  await openFromMenu(page, 'Memory')
  const forgets = main(page).getByRole('button', { name: 'Forget', exact: true })
  await expect(forgets).toHaveCount(3)
  await forgets.first().click()
  await expect(forgets).toHaveCount(2)
  await expect(toast(page, 'Forgotten. Your Inhouse agent will no longer use this.')).toBeVisible()
  await noSidewaysScroll(page)

  await page.reload()
  await expect(forgets).toHaveCount(2)
  await openFromMenu(page, 'Notifications')
  await expect(weekly).not.toBeChecked()
  await expect(main(page).getByRole('combobox', { name: 'Approvals waiting: Once an hour', exact: true })).toBeVisible()
})

test('Phone: Inhouse agent, Data and access and Audit log read as text, and their buttons still work', async ({ fx, page }) => {
  await start(page, fx, '#/today')
  await openFromMenu(page, 'Inhouse agent')
  await expect(page.getByRole('note')).toContainText('Change these on a computer.')
  await expect(main(page).getByRole('combobox')).toHaveCount(0)
  await expect(main(page).getByRole('textbox')).toHaveCount(0)
  await expectRow(page, 'Tone', 'Friendly and short', 'Signs emails as')
  await expectRow(page, 'Signs emails as', 'The Northline team', 'Tone')
  await main(page).getByRole('button', { name: 'Open memory', exact: true }).click()
  await expect(h1(page, 'Team memory')).toBeVisible()
  await openFromMenu(page, 'Inhouse agent')
  await main(page).getByRole('button', { name: 'View skills', exact: true }).click()
  await expect(h1(page, 'Skills')).toBeVisible()
  await expect(page).toHaveURL(/#\/skills$/)

  await openFromMenu(page, 'Data and access')
  await expect(page.getByRole('note')).toContainText('Change these on a computer.')
  await expect(main(page).getByRole('switch')).toHaveCount(0)
  await expect(main(page).getByRole('combobox')).toHaveCount(0)
  // Retention reads as its value, a switch as On.
  await expectRow(page, 'Chats', '12 months', 'Activity and steps')
  await expectRow(page, 'Activity and steps', '12 months', 'Chats')
  await expectRow(page, 'Inhouse team access', /On$/, 'Two-step sign-in')
  await expectRow(page, 'Two-step sign-in', /On$/, 'Inhouse team access')
  await expectRow(page, 'Next cleanup', /at \d{1,2}:\d{2}\s?[AP]M$/, 'Audit log')
  const [file] = await Promise.all([page.waitForEvent('download'), main(page).getByRole('button', { name: 'Export', exact: true }).click()])
  expect(file.suggestedFilename()).toMatch(/^inhouse-export-\d{4}-\d{2}-\d{2}\.ndjson$/)
  await expect(toast(page, 'Sample export downloaded. The demo uses invented data.')).toBeVisible()
  await noSidewaysScroll(page)

  // The audit log is facts and a button: no note, the rows show, Download CSV is there.
  await openFromMenu(page, 'Audit log')
  await expect(page.getByRole('note')).toHaveCount(0)
  await expect(main(page).getByText('Sam Mercer changed an approval rule', { exact: true })).toBeVisible()
  await expect(main(page).getByRole('button', { name: 'Download CSV', exact: true })).toBeVisible()
  await noSidewaysScroll(page)
})

test('Phone: Help opens from the account menu, a guide opens and the window fits 390 px', async ({ fx, page }) => {
  await start(page, fx, '#/today')
  await page.getByRole('button', { name: 'Menu' }).click()
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: /account and settings/i }).click()
  await page.getByRole('menu', { name: 'Account' }).getByRole('menuitem', { name: 'Help and guides' }).click()
  const help = page.getByRole('dialog', { name: 'Help and guides' })
  await expect(help).toBeVisible()
  const guide = help.getByRole('button', { name: 'Keep an eye on spend' })
  await guide.click()
  await expect(guide).toHaveAttribute('aria-expanded', 'true')
  await expect(help).toContainText('Usage shows what your Inhouse agent cost this month')
  const box = (await help.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  await help.getByRole('button', { name: 'Ask the team' }).click()
  await expect(page.getByRole('dialog', { name: 'Your Inhouse team' })).toBeVisible()
  await expect(help).toHaveCount(0)
})
