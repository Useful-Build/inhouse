// Help and guides and the account menu's other items, at 1440. Help shows one guide at a time, and its Ask the team
// sends a question that lands among the open requests and stays after a reload. Send feedback opens the team window on
// Feedback; Your settings and Team settings open their pages. (Help's keyboard path is in overlays-keyboard.spec.ts,
// its focus return in cross-screen.spec.ts, Report a bug in report-bug.spec.ts, Sign out in sample-data.spec.ts.)
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

const side = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' })
const team = (page: Page) => page.getByRole('dialog', { name: 'Your Inhouse team' })
const help = (page: Page) => page.getByRole('dialog', { name: 'Help and guides' })

async function accountItem(page: Page, name: string) {
  const menu = page.getByRole('menu', { name: 'Account' })
  // A click on the trigger while the last menu is still closing is lost, so wait for it to be gone first.
  await expect(menu).toHaveCount(0)
  await side(page).getByRole('button', { name: /account and settings/i }).click()
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name, exact: true }).click()
}

test('Help: one guide open at a time; Ask the team sends a question that is listed and survives a reload', async ({ page }) => {
  await start(page, '#/today')
  await accountItem(page, 'Help and guides')
  await expect(help(page)).toBeVisible()
  await expect(help(page).locator('button[aria-expanded]')).toHaveCount(6)

  // Opening a guide shows its text; opening another closes the first.
  const approvals = help(page).getByRole('button', { name: 'How approvals work' })
  const rule = help(page).getByRole('button', { name: 'Teach a rule' })
  await approvals.click()
  await expect(approvals).toHaveAttribute('aria-expanded', 'true')
  await expect(help(page)).toContainText('never spends money or messages a customer on its own')
  await rule.click()
  await expect(rule).toHaveAttribute('aria-expanded', 'true')
  await expect(approvals).toHaveAttribute('aria-expanded', 'false')
  await expect(help(page)).toContainText('Tell your Inhouse agent once, in a chat.')
  await expect(help(page)).not.toContainText('never spends money or messages a customer on its own')
  // And the open one closes again.
  await rule.click()
  await expect(rule).toHaveAttribute('aria-expanded', 'false')

  // Ask the team: Help gives way to the team window, on Feedback, with the start of a question written.
  await help(page).getByRole('button', { name: 'Ask the team' }).click()
  await expect(help(page)).toHaveCount(0)
  await expect(team(page)).toBeVisible()
  await expect(team(page).getByRole('radio', { name: /Feedback/ })).toBeChecked()
  const text = team(page).getByRole('textbox', { name: 'Your request' })
  await expect(text).toHaveValue('I have a question: ')
  await text.fill('I have a question: can a routine run twice a day?')
  await team(page).getByRole('button', { name: 'Send to the team' }).click()
  await expect(team(page)).toHaveCount(0)
  await expect(page.locator('[data-toast]').filter({ hasText: 'Request sent. Your Inhouse team replies within one working day.' })).toBeVisible()

  // It is listed first among the open requests, as feedback from Sam, and a reload keeps it.
  const listed = (p: Page) => team(p).getByText('I have a question: can a routine run twice a day?', { exact: true })
  await side(page).getByRole('button', { name: 'Message the team →' }).click()
  await expect(listed(page)).toBeVisible()
  // Request titles are the bold lines under "Open requests"; the new one is the first.
  // The first row under "Open requests" (the selected row's icon and status sit in the same row, so contain, not equal).
  await expect(team(page).getByRole('heading', { name: 'Open requests' }).locator('xpath=following-sibling::div[1]/div[1]')).toContainText('I have a question: can a routine run twice a day?')
  await expect(team(page).getByText('Feedback · sent by Sam Mercer, just now', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.reload()
  await side(page).getByRole('button', { name: 'Message the team →' }).click()
  await expect(listed(page)).toBeVisible()
})

test('Account menu: Send feedback opens the team window on Feedback; Your settings and Team settings open their pages', async ({ page }) => {
  await start(page, '#/today')
  await accountItem(page, 'Send feedback')
  await expect(team(page)).toBeVisible()
  await expect(team(page).getByRole('radio', { name: /Feedback/ })).toBeChecked()
  const text = team(page).getByRole('textbox', { name: 'Your request' })
  await expect(text).toHaveValue('')
  await expect(text).toHaveAttribute('placeholder', 'What would make Inhouse better for you?')
  // Feedback has no screenshot box: that's for bugs.
  await expect(team(page).getByRole('checkbox', { name: /Attach a screenshot/ })).toHaveCount(0)
  await expect(team(page).getByRole('button', { name: 'Send to the team' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(team(page)).toHaveCount(0)

  await accountItem(page, 'Your settings')
  await expect(page.getByRole('heading', { level: 1, name: 'General', exact: true })).toBeVisible()
  await expect(page).toHaveURL(/#\/settings\/you-general$/)
  await accountItem(page, 'Team settings')
  await expect(page.getByRole('heading', { level: 1, name: 'Stage and plan', exact: true })).toBeVisible()
  await expect(page).toHaveURL(/#\/settings\/team-plan$/)
})
