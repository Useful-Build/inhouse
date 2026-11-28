// Settings > Memory (your own page), at 1440. Each control does what it says; the picks survive a reload and Reset demo
// clears them. The Notifications page left the demo with its stages (decision A13, option B), as it left the product;
// Always allowed is asking-demo.spec.ts's. The phone twin is settings-pages-phone.spec.ts.
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
const sw = (page: Page, name: string) => main(page).getByRole('switch', { name, exact: true })

/** Reset demo (Normal comes back, Today opens). */
async function resetDemo(page: Page) {
  await page.getByRole('button', { name: /Demo switches/ }).click()
  const switches = page.getByRole('dialog', { name: 'Demo switches' })
  await switches.getByRole('button', { name: 'Reset demo' }).click()
  await expect(page.getByRole('heading', { level: 1 }).first()).toContainText('things need you')
  await page.getByRole('button', { name: 'Close demo switches' }).click()
}

const PERSONAL = [
  'You like numbers in a table, most urgent first.',
  'You want short answers, with the source for each number.',
  'You handle supplier emails yourself. Dana handles money.',
]

test('Memory: the lines, Forget and the learn switch are available, and privacy is said as a fact', async ({ fx, page }) => {
  await start(page, fx, '#/settings/you-memory')
  await expect(page.getByRole('heading', { level: 1, name: 'Memory', exact: true })).toBeVisible()
  for (const line of PERSONAL) await expect(main(page).getByText(line, { exact: true })).toBeVisible()
  const forgets = main(page).getByRole('button', { name: 'Forget', exact: true })
  await expect(forgets).toHaveCount(3)
  for (const forget of await forgets.all()) await expect(forget).toBeEnabled()
  await expect(sw(page, 'Learn from my chats')).toBeEnabled()
  // Privacy is a fact, not a control.
  await expect(main(page).getByText('Private', { exact: true })).toBeVisible()
})

test('Memory: Forget (with Undo) and the learn switch work, survive a reload and Reset demo clears them', async ({ fx, page }) => {
  await start(page, fx, '#/settings/you-memory')
  const forgets = main(page).getByRole('button', { name: 'Forget', exact: true })
  const learn = sw(page, 'Learn from my chats')
  await expect(forgets).toHaveCount(3)
  await expect(learn).toBeChecked()

  // Forget takes the line away and says so; Undo brings it back.
  await forgets.first().click()
  await expect(main(page).getByText(PERSONAL[0], { exact: true })).toHaveCount(0)
  await expect(forgets).toHaveCount(2)
  const forgotten = toast(page, 'Forgotten. Your Inhouse agent will no longer use this.')
  await expect(forgotten).toBeVisible()
  await forgotten.getByRole('button', { name: 'Undo' }).click()
  await expect(main(page).getByText(PERSONAL[0], { exact: true })).toBeVisible()
  await expect(forgets).toHaveCount(3)

  // Forget the second line and turn learning off: both survive a reload, and the other lines stay.
  // The line's row: the innermost block holding its text and a Forget button (not the card around all of them).
  const line = main(page).locator('div').filter({ has: page.getByText(PERSONAL[1], { exact: true }) }).filter({ has: page.getByRole('button', { name: 'Forget' }) }).last()
  await expect(line.getByRole('button', { name: 'Forget' })).toHaveCount(1)
  await line.getByRole('button', { name: 'Forget' }).click()
  await expect(main(page).getByText(PERSONAL[1], { exact: true })).toHaveCount(0)
  await learn.click()
  await expect(learn).not.toBeChecked()
  await page.reload()
  await expect(forgets).toHaveCount(2)
  await expect(main(page).getByText(PERSONAL[1], { exact: true })).toHaveCount(0)
  await expect(main(page).getByText(PERSONAL[0], { exact: true })).toBeVisible()
  await expect(main(page).getByText(PERSONAL[2], { exact: true })).toBeVisible()
  await expect(learn).not.toBeChecked()

  // Your memory is your own: Team memory still has all its lines.
  await goTo(page, 'team-memory')
  await expect(main(page).getByRole('button', { name: 'Forget', exact: true })).toHaveCount(7)

  // Reset demo brings the line and the switch back.
  await resetDemo(page)
  await goTo(page, 'you-memory')
  await expect(forgets).toHaveCount(3)
  await expect(main(page).getByText(PERSONAL[1], { exact: true })).toBeVisible()
  await expect(learn).toBeChecked()
})
