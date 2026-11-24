// Ship spec for the setup project: the feature-map coverage it added (Notifications, Memory, Inhouse agent, Data and
// access, Audit log, Help). Recorded at 1440x900 and 390x844. Every page is opened through the UI, as a person would.
// On a phone the team pages read as text (their selects and fields are hidden) and Settings opens through a menu.
import { expect, test, type Fx } from '../support/fx.js'
import type { Page } from '@playwright/test'

const phone = () => test.info().project.name === 'ship-phone'

async function start(page: Page, fx: Fx) {
  await fx.seed({ stage: 'Act', demo: { ambient: 'Always' } })
  await page.goto('/?demo#/today')
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
}

const main = (page: Page) => page.getByRole('main')
const h1 = (page: Page, name: string) => page.getByRole('heading', { level: 1, name, exact: true })
const combo = (page: Page, name: string) => main(page).getByRole('combobox', { name, exact: true })
const team = (page: Page) => page.getByRole('dialog', { name: 'Your Inhouse team' })
const toast = (page: Page, text: string) => page.locator('[data-toast]').filter({ hasText: text })

/** Opens an account menu item; on a phone the sidebar is a drawer behind the Menu button. */
async function accountItem(page: Page, name: string) {
  if (phone()) await page.getByRole('button', { name: 'Menu' }).click()
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: /account and settings/i }).click()
  await page.getByRole('menu', { name: 'Account' }).getByRole('menuitem', { name, exact: true }).click()
}

/** Picks a page in Settings' menu. On a phone a page is shown alone, so go Back to the menu first when it is open. */
async function pickPage(page: Page, name: string) {
  const back = page.getByRole('button', { name: 'Back to settings' })
  if (await back.isVisible()) await back.click()
  await page.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name, exact: true }).click()
  await expect(h1(page, name)).toBeVisible()
}

test('S1: Notifications: change when approvals alert you, reload, the choice is kept', async ({ fx, page }) => {
  await start(page, fx)
  await accountItem(page, 'Your settings')
  await pickPage(page, 'Notifications')
  await combo(page, 'Approvals waiting: Right away').click()
  await page.getByRole('option', { name: 'Once an hour' }).click()
  await expect(combo(page, 'Approvals waiting: Once an hour')).toBeVisible()
  await page.reload()
  await expect(h1(page, 'Notifications')).toBeVisible()
  await expect(combo(page, 'Approvals waiting: Once an hour')).toBeVisible()
})

test('S2: Memory: forget a personal memory line, Undo brings it back', async ({ fx, page }) => {
  await start(page, fx)
  await accountItem(page, 'Your settings')
  await pickPage(page, 'Memory')
  const line = main(page).getByText('You like numbers in a table, most urgent first.', { exact: true })
  const forgets = main(page).getByRole('button', { name: 'Forget', exact: true })
  await expect(forgets).toHaveCount(3)
  await forgets.first().click()
  await expect(line).toHaveCount(0)
  await expect(forgets).toHaveCount(2)
  const forgotten = toast(page, 'Forgotten. Your Inhouse agent will no longer use this.')
  await expect(forgotten).toBeVisible()
  await forgotten.getByRole('button', { name: 'Undo' }).click()
  await expect(line).toBeVisible()
  await expect(forgets).toHaveCount(3)
})

test('S3: Inhouse agent: change the tone, then Open memory goes to Team memory', async ({ fx, page }) => {
  await start(page, fx)
  await accountItem(page, 'Team settings')
  await pickPage(page, 'Inhouse agent')
  if (phone()) {
    // Team pages are read-only on a phone: the tone shows as text.
    await expect(page.getByRole('note')).toContainText('Change these on a computer.')
    await expect(main(page).getByText('Friendly and short')).toBeVisible()
  } else {
    await combo(page, 'Tone: Friendly and short').click()
    await page.getByRole('option', { name: 'Formal and brief' }).click()
    await expect(combo(page, 'Tone: Formal and brief')).toBeVisible()
  }
  await main(page).getByRole('button', { name: 'Open memory', exact: true }).click()
  await expect(h1(page, 'Team memory')).toBeVisible()
  await expect(page).toHaveURL(/#\/settings\/team-memory$/)
})

test('S4: Data and access: change how long chats are kept; Ask the team opens with the delete request written', async ({ fx, page }) => {
  await start(page, fx)
  await accountItem(page, 'Team settings')
  await pickPage(page, 'Data and access')
  if (phone()) {
    // Retention reads as text on a phone.
    await expect(page.getByRole('note')).toContainText('Change these on a computer.')
    // The Chats row: the innermost block holding both its label and a retention value (no styling classes).
    const chatsRow = main(page).locator('div').filter({ has: page.getByText('Chats', { exact: true }) }).filter({ hasText: /\d+ months|Until deleted/ }).last()
    await expect(chatsRow).not.toContainText('Audit log') // the row itself, not the card around every row
    await expect(chatsRow).toContainText('12 months')
  } else {
    await combo(page, 'Chats: 12 months').click()
    await page.getByRole('option', { name: '6 months' }).click()
    await expect(combo(page, 'Chats: 6 months')).toBeVisible()
  }
  await main(page).getByRole('button', { name: 'Ask the team', exact: true }).click()
  await expect(team(page)).toBeVisible()
  await expect(team(page).getByRole('radio', { name: /Change something/ })).toBeChecked()
  await expect(team(page).getByRole('textbox', { name: 'Details' })).toHaveValue('Please delete the Inhouse agent and its data for Northline Outdoor.')
})

test('S5: Audit log: pause the Inhouse agent, the audit log shows it at the top; resume', async ({ fx, page }) => {
  await start(page, fx)
  await accountItem(page, 'Team settings')
  await pickPage(page, 'Spending cap')
  await main(page).getByRole('button', { name: 'Pause Inhouse agent', exact: true }).click()
  await expect(toast(page, 'Your Inhouse agent is paused.')).toBeVisible()
  // The top bar's pill shows on every desktop page; on a phone only on Today.
  if (!phone()) await expect(page.getByRole('status', { name: 'Inhouse agent is paused' })).toBeVisible()
  await pickPage(page, 'Audit log')
  const paused = main(page).getByText('Sam Mercer paused your Inhouse agent', { exact: true })
  const seeded = main(page).getByText('Sam Mercer changed an approval rule', { exact: true })
  await expect(paused).toBeVisible()
  await expect(seeded).toBeVisible()
  const top = async (l: typeof paused) => (await l.boundingBox())!.y
  expect(await top(paused)).toBeLessThan(await top(seeded))
  await pickPage(page, 'Spending cap')
  await main(page).getByRole('button', { name: 'Resume Inhouse agent', exact: true }).click()
  await expect(toast(page, 'Your Inhouse agent is running again')).toBeVisible()
  await pickPage(page, 'Audit log')
  await expect(paused).toHaveCount(0)
})

test('S6: Help and guides: open a guide, then ask the team a question and see it listed', async ({ fx, page }) => {
  await start(page, fx)
  await accountItem(page, 'Help and guides')
  const help = page.getByRole('dialog', { name: 'Help and guides' })
  await expect(help).toBeVisible()
  const guide = help.getByRole('button', { name: 'How approvals work' })
  await guide.click()
  await expect(guide).toHaveAttribute('aria-expanded', 'true')
  await expect(help).toContainText('never spends money or messages a customer on its own')
  await help.getByRole('button', { name: 'Ask the team' }).click()
  await expect(team(page)).toBeVisible()
  const question = 'I have a question: can a routine run twice a day?'
  await team(page).getByRole('textbox', { name: 'Details' }).fill(question)
  await team(page).getByRole('button', { name: 'Send to the team' }).click()
  await expect(team(page)).toHaveCount(0)
  await expect(toast(page, 'Request sent. Your Inhouse team replies within one working day.')).toBeVisible()
  if (phone()) await page.getByRole('button', { name: 'Menu' }).click()
  // The team lives in the account menu (#226): "Your Inhouse team", with its open requests counted.
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: /account and settings/i }).click()
  await page.getByRole('menu', { name: 'Account' }).getByRole('menuitem', { name: /^Your Inhouse team/ }).click()
  await expect(team(page).getByText(question, { exact: true })).toBeVisible()
})
