// Settings > Notifications and Memory (your own pages), at 1440. Each control does what it says; the picks survive a
// reload and Reset demo clears them. At Watch both pages are locked until Act. The phone twin is
// settings-pages-phone.spec.ts.
import { expect, test } from './csp.js'
import type { Page } from '@playwright/test'

type Stage = 'Watch' | 'Act' | 'Run'

async function start(page: Page, stage: Stage, hash: string) {
  await page.addInitScript(s => {
    if (sessionStorage.getItem('e2e-seeded')) return
    localStorage.clear()
    localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: s, scenario: 'Normal', ambient: 'Off', animateMark: false }))
    sessionStorage.setItem('e2e-seeded', '1')
  }, stage)
  await page.goto('/?demo' + hash)
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
}

const main = (page: Page) => page.getByRole('main')
const toast = (page: Page, text: string) => page.locator('[data-toast]').filter({ hasText: text })
const goTo = (page: Page, tab: string) => page.evaluate(t => { location.hash = `#/settings/${t}` }, tab)
const combo = (page: Page, name: string) => main(page).getByRole('combobox', { name, exact: true })
const sw = (page: Page, name: string) => main(page).getByRole('switch', { name, exact: true })

/** Reset demo (Act and Normal come back, Today opens). */
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

test('Notifications and Memory at Watch: the alerts, the memory lines and the learn switch are locked until Act', async ({ page }) => {
  await start(page, 'Watch', '#/settings/you-notif')
  await expect(page.getByRole('heading', { level: 1, name: 'Notifications', exact: true })).toBeVisible()
  await expect(main(page).getByRole('combobox', { name: /^Approvals waiting/ })).toBeDisabled()
  await expect(main(page).getByRole('combobox', { name: /^Send alerts to/ })).toBeDisabled()
  await expect(main(page).getByRole('switch', { name: 'Weekly report' })).toBeDisabled()

  await goTo(page, 'you-memory')
  await expect(page.getByRole('heading', { level: 1, name: 'Memory', exact: true })).toBeVisible()
  // A locked row's text node also holds its screen-reader note ("Locked, included in a later stage: Act"), so match a substring.
  for (const line of PERSONAL) await expect(main(page).getByText(line)).toBeVisible()
  await expect(main(page).getByRole('button', { name: 'Forget', exact: true })).toHaveCount(3)
  await expect(main(page).locator('button:not([disabled])', { hasText: /^Forget$/ })).toHaveCount(0)
  await expect(main(page).getByRole('switch', { name: 'Learn from my chats' })).toBeDisabled()
  // Privacy is a fact, not a control: it shows at every stage.
  await expect(main(page).getByText('Private', { exact: true })).toBeVisible()
})

test('Notifications: alert timing, where alerts go and both switches change, survive a reload and Reset demo clears them', async ({ page }) => {
  await start(page, 'Act', '#/settings/you-notif')
  await expect(combo(page, 'Approvals waiting: Right away')).toBeVisible()
  await expect(combo(page, 'Send alerts to: Slack')).toBeVisible()
  await expect(sw(page, 'Slack')).toBeChecked()
  await expect(sw(page, 'Weekly report')).toBeChecked()

  // Each dropdown lists its real choices and saves the one picked.
  await combo(page, 'Approvals waiting: Right away').click()
  await expect(page.getByRole('listbox', { name: 'Approvals waiting' }).getByRole('option')).toHaveText([/^Right away(\s*check)?$/, /^Once an hour(\s*check)?$/, /^Once a day(\s*check)?$/])
  await page.getByRole('option', { name: 'Once a day' }).click()
  await expect(combo(page, 'Approvals waiting: Once a day')).toBeVisible()
  await combo(page, 'Send alerts to: Slack').click()
  await expect(page.getByRole('listbox', { name: 'Send alerts to' }).getByRole('option')).toHaveText([/^Email(\s*check)?$/, /^Slack(\s*check)?$/, /^Email and Slack(\s*check)?$/, /^In the app only(\s*check)?$/])
  await page.getByRole('option', { name: 'In the app only' }).click()
  await expect(combo(page, 'Send alerts to: In the app only')).toBeVisible()
  await sw(page, 'Slack').click()
  await expect(sw(page, 'Slack')).not.toBeChecked()
  await sw(page, 'Weekly report').click()
  await expect(sw(page, 'Weekly report')).not.toBeChecked()

  // A reload keeps every pick.
  await page.reload()
  await expect(combo(page, 'Approvals waiting: Once a day')).toBeVisible()
  await expect(combo(page, 'Send alerts to: In the app only')).toBeVisible()
  await expect(sw(page, 'Slack')).not.toBeChecked()
  await expect(sw(page, 'Weekly report')).not.toBeChecked()

  // Reset demo puts the defaults back, and a reload keeps them.
  await resetDemo(page)
  await goTo(page, 'you-notif')
  await expect(combo(page, 'Approvals waiting: Right away')).toBeVisible()
  await expect(combo(page, 'Send alerts to: Slack')).toBeVisible()
  await expect(sw(page, 'Slack')).toBeChecked()
  await expect(sw(page, 'Weekly report')).toBeChecked()
  await page.reload()
  await expect(combo(page, 'Send alerts to: Slack')).toBeVisible()
  await expect(sw(page, 'Weekly report')).toBeChecked()
})

test('Memory: Forget (with Undo) and the learn switch work, survive a reload and Reset demo clears them', async ({ page }) => {
  await start(page, 'Act', '#/settings/you-memory')
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
