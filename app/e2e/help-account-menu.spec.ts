// Help and guides and the account menu's other items, at 1440. Help shows one guide at a time, and its Ask the team
// sends a question that lands among the open requests and stays after a reload. Your Inhouse team opens the team window
// and counts its open requests; Usage, Your settings and Team settings open their pages. (Help's keyboard path is in overlays-keyboard.spec.ts,
// its focus return in cross-screen.spec.ts, Report a bug in report-bug.spec.ts, Sign out in sample-data.spec.ts.)
import { expect, fxFor, test } from './support/fx.js'
import type { Page } from '@playwright/test'

async function start(page: Page, hash: string) {
  await fxFor(page, undefined).seed({})
  await page.goto('/?demo' + hash)
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
}

const side = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' })
const team = (page: Page) => page.getByRole('dialog', { name: 'Your Inhouse team' })
const help = (page: Page) => page.getByRole('dialog', { name: 'Help and guides' })

async function accountItem(page: Page, name: string | RegExp) {
  const menu = page.getByRole('menu', { name: 'Account' })
  // A click on the trigger while the last menu is still closing is lost, so wait for it to be gone first.
  await expect(menu).toHaveCount(0)
  await side(page).getByRole('button', { name: /account and settings/i }).click()
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', typeof name === 'string' ? { name, exact: true } : { name }).click()
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
  const text = team(page).getByRole('textbox', { name: 'Details' })
  await expect(text).toHaveValue('I have a question: ')
  await text.fill('I have a question: can a routine run twice a day?')
  await team(page).getByRole('button', { name: 'Send to the team' }).click()
  await expect(team(page)).toHaveCount(0)
  await expect(page.locator('[data-toast]').filter({ hasText: 'Request sent. Your Inhouse team replies within one working day.' })).toBeVisible()

  // It is listed first among your open requests, as your feedback, and a reload keeps it.
  const listed = (p: Page) => team(p).getByText('I have a question: can a routine run twice a day?', { exact: true })
  const yourRequests = (p: Page) => team(p).getByRole('radio', { name: /^Your requests/ }).click()
  await accountItem(page, /^Your Inhouse team/)
  await yourRequests(page)
  await expect(listed(page)).toBeVisible()
  await expect(team(page).getByRole('list', { name: 'Open requests' }).getByRole('listitem').first()).toContainText('I have a question: can a routine run twice a day?')
  await expect(team(page).getByText('Feedback · You, just now', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.reload()
  await accountItem(page, /^Your Inhouse team/)
  await yourRequests(page)
  await expect(listed(page)).toBeVisible()
})

test('Account menu: Your Inhouse team opens the team window with its open requests counted; Feedback is a chip there; Usage, Your settings and Team settings open their pages', async ({ page }) => {
  await start(page, '#/today')
  // One team entry, no Report a bug or Send feedback items.
  await side(page).getByRole('button', { name: /account and settings/i }).click()
  const menu = page.getByRole('menu', { name: 'Account' })
  const item = menu.getByRole('menuitem', { name: /^Your Inhouse team/ })
  await expect(item).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Report a bug' })).toHaveCount(0)
  await expect(menu.getByRole('menuitem', { name: 'Send feedback' })).toHaveCount(0)
  const counted = Number((await item.textContent())!.match(/(\d+) open/)![1])
  await item.click()
  await expect(team(page)).toBeVisible()
  // The count is the number of open requests, the same number "Your requests" shows.
  await team(page).getByRole('radio', { name: /^Your requests/ }).click()
  await expect(team(page).getByRole('radio', { name: `Your requests ${counted}` })).toBeVisible()
  await expect(team(page).getByRole('list', { name: 'Open requests' }).getByRole('listitem')).toHaveCount(counted)
  await team(page).getByRole('radio', { name: 'New request' }).click()
  // Feedback is one of the window's request types: no screenshot box, Send waits for words.
  await team(page).getByRole('radio', { name: /Feedback/ }).click()
  const text = team(page).getByRole('textbox', { name: 'Details' })
  await expect(text).toHaveValue('')
  await expect(text).toHaveAttribute('placeholder', 'What would make Inhouse better for you?')
  await expect(team(page).getByRole('checkbox', { name: /Attach a screenshot/ })).toHaveCount(0)
  await expect(team(page).getByRole('button', { name: 'Send to the team' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(team(page)).toHaveCount(0)

  // Usage lives in the account menu, and the account row shows selected there.
  await accountItem(page, 'Usage')
  await expect(page.getByRole('heading', { level: 1, name: 'Usage' })).toBeVisible()
  await expect(page).toHaveURL(/#\/usage$/)
  await expect(side(page).getByRole('button', { name: /account and settings/i })).toHaveAttribute('aria-current', 'page')

  await accountItem(page, 'Your settings')
  await expect(page.getByRole('heading', { level: 1, name: 'General', exact: true })).toBeVisible()
  await expect(page).toHaveURL(/#\/settings\/you-general$/)
  // Stage and plan, where Team settings opened in the demo, left with its stages (decision A13): the first team page now.
  await accountItem(page, 'Team settings')
  await expect(page.getByRole('heading', { level: 1, name: 'Inhouse agent', exact: true })).toBeVisible()
  await expect(page).toHaveURL(/#\/settings\/team-agent$/)
})
