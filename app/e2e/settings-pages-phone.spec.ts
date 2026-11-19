// Phone (390): your own Settings pages (Notifications, Memory) keep their controls and a change survives a reload; the
// team pages Inhouse agent, Data and access and Audit log read as text (decision D4) while their buttons still work;
// Help opens from the account menu and fits. The desktop flows are in settings-your-pages.spec.ts,
// settings-agent-data.spec.ts and help-account-menu.spec.ts.
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

async function start(page: Page, hash: string) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-seeded')) return
    localStorage.clear()
    localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: 'Act', scenario: 'Normal', ambient: 'Off', animateMark: false }))
    sessionStorage.setItem('e2e-seeded', '1')
  })
  await page.goto('/?demo' + hash)
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
}

const main = (page: Page) => page.getByRole('main')
const h1 = (page: Page, name: string) => page.getByRole('heading', { level: 1, name, exact: true })
/** The settings row with this title. */
const row = (page: Page, title: string) => main(page).getByText(title, { exact: true }).locator('xpath=ancestor::div[contains(@class,"py-4")][1]')
const toast = (page: Page, text: string) => page.locator('[data-toast]').filter({ hasText: text })
const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => [document.documentElement, document.querySelector('main')!].every(e => e.scrollWidth - e.clientWidth <= 1))

/** On a phone Settings shows its menu first: pick a page from it. */
async function openFromMenu(page: Page, name: string) {
  await page.evaluate(() => { location.hash = '#/settings' })
  await expect(h1(page, 'Settings')).toBeVisible()
  await page.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name, exact: true }).click()
  await expect(h1(page, name)).toBeVisible()
}

test('Phone: Notifications and Memory keep their controls, and a change survives a reload', async ({ page }) => {
  await start(page, '#/today')
  await openFromMenu(page, 'Notifications')
  await expect(page.getByRole('note')).toHaveCount(0)
  const weekly = main(page).getByRole('switch', { name: 'Weekly report', exact: true })
  await expect(weekly).toBeChecked()
  await weekly.click()
  await expect(weekly).not.toBeChecked()
  await main(page).getByRole('combobox', { name: 'Approvals waiting: Right away', exact: true }).click()
  await page.getByRole('option', { name: 'Once an hour' }).click()
  await expect(main(page).getByRole('combobox', { name: 'Approvals waiting: Once an hour', exact: true })).toBeVisible()
  expect(await noSidewaysScroll(page)).toBe(true)

  await openFromMenu(page, 'Memory')
  const forgets = main(page).getByRole('button', { name: 'Forget', exact: true })
  await expect(forgets).toHaveCount(3)
  await forgets.first().click()
  await expect(forgets).toHaveCount(2)
  await expect(toast(page, 'Forgotten. Your Inhouse agent will no longer use this.')).toBeVisible()
  expect(await noSidewaysScroll(page)).toBe(true)

  await page.reload()
  await expect(forgets).toHaveCount(2)
  await openFromMenu(page, 'Notifications')
  await expect(weekly).not.toBeChecked()
  await expect(main(page).getByRole('combobox', { name: 'Approvals waiting: Once an hour', exact: true })).toBeVisible()
})

test('Phone: Inhouse agent, Data and access and Audit log read as text, and their buttons still work', async ({ page }) => {
  await start(page, '#/today')
  await openFromMenu(page, 'Inhouse agent')
  await expect(page.getByRole('note')).toContainText('Change these on a computer.')
  await expect(main(page).getByRole('combobox')).toHaveCount(0)
  await expect(main(page).getByRole('textbox')).toHaveCount(0)
  await expect(row(page, 'Tone')).toContainText('Friendly and short')
  await expect(row(page, 'Signs emails as')).toContainText('The Northline team')
  await main(page).getByRole('button', { name: 'Open memory', exact: true }).click()
  await expect(h1(page, 'Team memory')).toBeVisible()

  await openFromMenu(page, 'Data and access')
  await expect(page.getByRole('note')).toContainText('Change these on a computer.')
  await expect(main(page).getByRole('switch')).toHaveCount(0)
  await expect(main(page).getByRole('combobox')).toHaveCount(0)
  // Retention reads as its value, a switch as On.
  await expect(row(page, 'Chats')).toContainText('12 months')
  await expect(row(page, 'Activity and steps')).toContainText('12 months')
  await expect(row(page, 'Inhouse team access')).toContainText(/On$/)
  await expect(row(page, 'Two-step sign-in')).toContainText(/On$/)
  await main(page).getByRole('button', { name: 'Export', exact: true }).click()
  await expect(toast(page, "Export isn't connected in this demo.")).toBeVisible()
  expect(await noSidewaysScroll(page)).toBe(true)

  // The audit log is facts and a button: no note, the rows show, Download CSV is there.
  await openFromMenu(page, 'Audit log')
  await expect(page.getByRole('note')).toHaveCount(0)
  await expect(main(page).getByText('Sam Mercer changed an approval rule', { exact: true })).toBeVisible()
  await expect(main(page).getByRole('button', { name: 'Download CSV', exact: true })).toBeVisible()
  expect(await noSidewaysScroll(page)).toBe(true)
})

test('Phone: Help opens from the account menu, a guide opens and the window fits 390 px', async ({ page }) => {
  await start(page, '#/today')
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
