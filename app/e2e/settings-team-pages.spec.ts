// Settings > Team memory and Spending cap's Pause (desktop: on a phone these team pages are read-only). Each control does
// what it says; the picks the app keeps (forgotten lines, the rule switch, pause) survive a reload and Reset demo clears
// them. Stage and plan and Run limits left the demo with its stages (decision A13, option B), as they left the product.
import { expect, test, type Fx } from './support/fx.js'
import type { Page } from '@playwright/test'

async function start(page: Page, fx: Fx, hash: string) {
  await fx.seed({})
  await page.goto('/?demo' + hash)
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
}

const main = (page: Page) => page.getByRole('main')
const toast = (page: Page, text: string) => page.locator('[data-toast]').filter({ hasText: text })
const goTo = (page: Page, tab: string) => page.evaluate(t => { location.hash = `#/settings/${t}` }, tab)
/** Reset demo (Normal comes back, Today opens). */
async function resetDemo(page: Page) {
  await page.getByRole('button', { name: /Demo switches/ }).click()
  const switches = page.getByRole('dialog', { name: 'Demo switches' })
  await switches.getByRole('button', { name: 'Reset demo' }).click()
  await expect(page.getByRole('heading', { level: 1 }).first()).toContainText('left to approve today')
  await page.getByRole('button', { name: 'Close demo switches' }).click()
}

test('Team memory: the lines, rule switch and Teach are available', async ({ fx, page }) => {
  await start(page, fx, '#/settings/team-memory')
  await expect(main(page).getByText('Kestrel Supply ships in 14 days and wants purchase orders as a PDF.')).toBeVisible()
  const forgets = main(page).getByRole('button', { name: 'Forget', exact: true })
  await expect(forgets).toHaveCount(7)
  for (const forget of await forgets.all()) await expect(forget).toBeEnabled()
  await expect(main(page).getByRole('switch', { name: 'Ask before saving a team rule' })).toBeEnabled()
  await expect(main(page).getByRole('button', { name: 'Teach in a chat', exact: true })).toBeEnabled()
})

test('Team memory: Forget (with Undo) and the rule switch work, survive a reload and Reset demo clears them; Teach in a chat opens a chat', async ({ fx, page }) => {
  await start(page, fx, '#/settings/team-memory')
  const first = 'Kestrel Supply ships in 14 days and wants purchase orders as a PDF.'
  const forgets = main(page).getByRole('button', { name: 'Forget', exact: true })
  const ask = main(page).getByRole('switch', { name: 'Ask before saving a team rule' })
  await expect(forgets).toHaveCount(7)
  await expect(ask).toBeChecked()

  // Forget takes the line away and says so; Undo brings it back.
  await forgets.first().click()
  await expect(main(page).getByText(first)).toHaveCount(0)
  await expect(forgets).toHaveCount(6)
  const forgotten = toast(page, 'Forgotten. Your Inhouse agent will no longer use this.')
  await expect(forgotten).toBeVisible()
  await forgotten.getByRole('button', { name: 'Undo' }).click()
  await expect(main(page).getByText(first)).toBeVisible()
  await expect(forgets).toHaveCount(7)

  // Forget again and turn the rule switch off: both survive a reload, and the Inhouse agent page counts what is left.
  await forgets.first().click()
  await expect(forgets).toHaveCount(6)
  await ask.click()
  await expect(ask).not.toBeChecked()
  await page.reload()
  await expect(forgets).toHaveCount(6)
  await expect(main(page).getByText(first)).toHaveCount(0)
  await expect(ask).not.toBeChecked()
  await goTo(page, 'team-agent')
  await expect(main(page).getByText('Supplier, customer and stock rules the whole team shares. 6 things remembered.')).toBeVisible()

  // Reset demo brings every line and the switch back.
  await resetDemo(page)
  await goTo(page, 'team-memory')
  await expect(forgets).toHaveCount(7)
  await expect(main(page).getByText(first)).toBeVisible()
  await expect(ask).toBeChecked()
  await page.reload()
  await expect(forgets).toHaveCount(7)
  await expect(ask).toBeChecked()

  // Teach in a chat opens a new chat with the start of a rule in the field.
  await main(page).getByRole('button', { name: 'Teach in a chat', exact: true }).click()
  await expect(page.getByRole('textbox', { name: /^(Ask|Message) Inhouse$/ })).toHaveValue('Remember that ')
})

test('Spending cap: Pause works, survives a reload and Reset demo clears it', async ({ fx, page }) => {
  await start(page, fx, '#/settings/team-spend')
  const status = (what: 'paused' | 'running') => page.getByRole('status', { name: `Inhouse agent is ${what}`, exact: true })
  const pause = main(page).getByRole('button', { name: 'Pause Inhouse agent', exact: true })
  const resume = main(page).getByRole('button', { name: 'Resume Inhouse agent', exact: true })

  // Pause stops the agent, says so in the top bar and flips the button; Resume undoes it.
  await pause.click()
  await expect(toast(page, 'Your Inhouse agent is paused. Chats, routines and jobs are stopped.')).toBeVisible()
  await expect(resume).toBeVisible()
  await expect(status('paused')).toBeVisible()
  await resume.click()
  await expect(toast(page, 'Your Inhouse agent is running again')).toBeVisible()
  await expect(pause).toBeVisible()
  await expect(status('paused')).toHaveCount(0)
  await pause.click()
  await expect(status('paused')).toBeVisible()

  // It survives a reload.
  await page.reload()
  await expect(resume).toBeVisible()
  await expect(status('paused')).toBeVisible()

  // Reset demo puts it back to running, and a reload keeps that.
  await resetDemo(page)
  await goTo(page, 'team-spend')
  await expect(pause).toBeVisible()
  await expect(status('paused')).toHaveCount(0)
  await page.reload()
  await expect(pause).toBeVisible()
})
