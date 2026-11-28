// PR 7, Pages and windows, at 390: the same checks as pages-polish.spec.ts, plus team settings that read as text
// (decision D4) and an Activity row that fits.
import { expect, test } from './support/fx.js'
import { pagesPolish } from './pages-polish-checks.js'

pagesPolish(test, 'phone')

test('Phone: team settings read as text with a note, your own settings keep their controls, Activity rows fit', async ({ page, fx }) => {
  await fx.seed({})
  await page.goto('/?demo#/settings/team-spend')
  await expect(page.getByRole('note')).toContainText('Change these on a computer.')
  await expect(page.getByRole('textbox', { name: 'Monthly cap' })).toHaveCount(0)
  await expect(page.getByRole('combobox')).toHaveCount(0)
  await expect(page.locator('main')).toContainText('$250')
  await page.evaluate(() => { location.hash = '#/settings/team-members' })
  await expect(page.getByRole('heading', { level: 1, name: 'Members' })).toBeVisible()
  // A button opens something, so it keeps working on a phone (D4 is for controls that change a value).
  await expect(page.getByRole('button', { name: 'Invite' })).toBeVisible()
  // Pause lives on the page that keeps Spending cap (it moved off Run limits); a button opens or does something, so it stays on a phone.
  await page.evaluate(() => { location.hash = '#/settings/team-spend' })
  await expect(page.getByRole('button', { name: /^(Pause|Resume) Inhouse agent$/ })).toBeVisible()
  // Your own settings keep their controls.
  await page.evaluate(() => { location.hash = '#/settings/you-general' })
  await expect(page.getByRole('textbox', { name: 'Name' })).toBeVisible()
  // Activity: a line keeps its time on the right, and opens as a bottom sheet inside the screen.
  await page.evaluate(() => { location.hash = '#/activity' })
  const row = page.locator('button[data-activity-row]').first()
  await expect(row.locator('[data-activity-time]')).toHaveText(/\d:\d\d\s?[AP]M/)
  await row.click()
  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible()
  const sb = await sheet.boundingBox(), vp = page.viewportSize()
  expect(sb && vp && sb.x >= 0 && sb.x + sb.width <= vp.width && sb.y + sb.height <= vp.height).toBe(true)
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => [document.documentElement, document.querySelector('main')!].every(e => e.scrollWidth - e.clientWidth <= 1))).toBe(true)
})
