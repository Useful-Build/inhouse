// PR 7, Pages and windows, at 390: the same checks as pages-polish.spec.ts, plus team settings that read as text
// (decision D4) and an Activity row that fits.
import { expect, test } from '@playwright/test'
import { pagesPolish } from './pages-polish-checks.js'

pagesPolish(test, 'phone')

test('Phone: team settings read as text with a note, your own settings keep their controls, Activity rows fit', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-seeded')) return
    localStorage.clear()
    localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: 'Act', scenario: 'Normal', ambient: 'Off', animateMark: false }))
    sessionStorage.setItem('e2e-seeded', '1')
  })
  await page.goto('/?demo#/settings/team-spend')
  await expect(page.getByRole('note')).toContainText('Change these on a computer.')
  await expect(page.getByRole('textbox', { name: 'Monthly cap' })).toHaveCount(0)
  await expect(page.getByRole('combobox')).toHaveCount(0)
  await expect(page.locator('main')).toContainText('$250')
  await page.evaluate(() => { location.hash = '#/settings/team-members' })
  await expect(page.getByRole('heading', { level: 1, name: 'Members' })).toBeVisible()
  // A button opens something, so it keeps working on a phone (D4 is for controls that change a value).
  await expect(page.getByRole('button', { name: 'Invite' })).toBeVisible()
  await page.evaluate(() => { location.hash = '#/settings/team-limits' })
  await expect(page.getByRole('button', { name: /^(Pause|Resume) Inhouse agent$/ })).toBeVisible()
  // Your own settings keep their controls.
  await page.evaluate(() => { location.hash = '#/settings/you-general' })
  await expect(page.getByRole('textbox', { name: 'Name' })).toBeVisible()
  // Activity: a line carries its time and person under it, and an opened line has no 72px indent.
  await page.evaluate(() => { location.hash = '#/activity' })
  const row = page.locator('button[data-activity-row]').first()
  await expect(row).toContainText(/\d:\d\d\s?[AP]M · /)
  await row.click()
  const box = await row.boundingBox()
  const fb = await row.locator('xpath=..').locator('dl').boundingBox()
  expect(box && fb && Math.abs(fb.x - box.x) < 40).toBe(true)
  expect(await page.evaluate(() => [document.documentElement, document.querySelector('main')!].every(e => e.scrollWidth - e.clientWidth <= 1))).toBe(true)
})
