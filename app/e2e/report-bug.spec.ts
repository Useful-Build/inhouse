// "Report a bug" from the ⌘K palette: the team window opens on the bug type, Send waits for words, sending closes the
// window, shows the confirmation and lists the report among the open requests. (`tour.spec.ts` checks the account
// menu's item opens the window; `navigation.spec.ts` checks Send for a plain request.)
import { expect, test, type Fx } from './support/fx.js'
import type { Page } from '@playwright/test'

async function start(page: Page, fx: Fx) {
  await fx.seed({ stage: 'Act', demo: { ambient: 'Always' } })
  await page.goto('/?demo#/today')
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
}

const palette = (page: Page) => page.getByRole('dialog', { name: 'Search' })
/** The team window, from the account menu's "Your Inhouse team" (it left the sidebar). */
async function openTeam(page: Page) {
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: /account and settings/i }).click()
  await page.getByRole('menu', { name: 'Account' }).getByRole('menuitem', { name: /^Your Inhouse team/ }).click()
}

test('Palette: Report a bug opens the bug window, Send waits for words, then the window closes and the confirmation shows', async ({ fx, page }) => {
  await start(page, fx)

  await page.keyboard.press('ControlOrMeta+k')
  await expect(palette(page)).toBeVisible()
  await palette(page).getByRole('option', { name: 'Report a bug' }).click()
  const team = page.getByRole('dialog', { name: 'Your Inhouse team' })
  await expect(team).toBeVisible()
  await expect(palette(page)).toHaveCount(0)

  // It opens on the bug type, with the bug wording and the screenshot box ticked.
  await expect(team.getByRole('radio', { name: /Report a bug/ })).toBeChecked()
  const text = team.getByRole('textbox', { name: 'Your request' })
  await expect(text).toHaveAttribute('placeholder', 'What happened, and what did you expect?')
  const shot = team.getByRole('checkbox', { name: /Attach a screenshot/ })
  await expect(shot).toBeChecked()
  await shot.click()
  await expect(shot).not.toBeChecked()
  await expect(team.getByText('Goes straight to the team, with the page you were on.')).toBeVisible()

  // Send waits for words: an empty field and whitespace alone both leave it off.
  const send = team.getByRole('button', { name: 'Send to the team' })
  await expect(send).toBeDisabled()
  await text.fill('  \n ')
  await expect(send).toBeDisabled()
  await text.fill('The Approve button does nothing on a refund card')
  await expect(send).toBeEnabled()
  await send.click()

  // The window closes and the confirmation shows.
  await expect(team).toHaveCount(0)
  await expect(page.locator('[data-toast]').filter({ hasText: 'Bug sent to your Inhouse team. Thank you.' })).toBeVisible()

  // The report is among the open requests, as a bug.
  await openTeam(page)
  await expect(team.getByText('The Approve button does nothing on a refund card', { exact: true })).toBeVisible()
  await expect(team.getByText(/^Report a bug · sent by .+, just now$/)).toBeVisible()
})
