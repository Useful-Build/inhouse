// Settings > Inhouse agent, Data and access and Audit log (desktop: on a phone these team pages are read-only, see
// settings-pages-phone.spec.ts). Each control does what it says; the picks the app keeps survive a reload and Reset demo
// clears them. The audit log's download is checked in sample-data.spec.ts.
import { expect, test } from '@playwright/test'
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
const h1 = (page: Page, name: string) => page.getByRole('heading', { level: 1, name, exact: true })
const combo = (page: Page, name: string) => main(page).getByRole('combobox', { name, exact: true })
const sw = (page: Page, name: string) => main(page).getByRole('switch', { name, exact: true })
const team = (page: Page) => page.getByRole('dialog', { name: 'Your Inhouse team' })

/** Reset demo (Act and Normal come back, Today opens). */
async function resetDemo(page: Page) {
  await page.getByRole('button', { name: /Demo switches/ }).click()
  const switches = page.getByRole('dialog', { name: 'Demo switches' })
  await switches.getByRole('button', { name: 'Reset demo' }).click()
  await expect(page.getByRole('heading', { level: 1 }).first()).toContainText('things need you')
  await page.getByRole('button', { name: 'Close demo switches' }).click()
}

test('Inhouse agent: tone and sign-off are saved, survive a reload and Reset demo clears them; its links open Team memory and Skills', async ({ page }) => {
  await start(page, 'Act', '#/settings/team-agent')
  await expect(h1(page, 'Inhouse agent')).toBeVisible()
  const signs = main(page).getByRole('textbox', { name: 'Signs emails as', exact: true })
  await expect(combo(page, 'Tone: Friendly and short')).toBeVisible()
  await expect(signs).toHaveValue('The Northline team')

  await combo(page, 'Tone: Friendly and short').click()
  await expect(page.getByRole('listbox', { name: 'Tone' }).getByRole('option')).toHaveText([/^Friendly and short/, /^Warm and detailed/, /^Formal and brief/, /^Plain and direct/])
  await page.getByRole('option', { name: 'Formal and brief' }).click()
  await expect(combo(page, 'Tone: Formal and brief')).toBeVisible()
  await signs.fill('Sam at Northline')
  await expect(toast(page, 'Saved')).toBeVisible()

  await page.reload()
  await expect(combo(page, 'Tone: Formal and brief')).toBeVisible()
  await expect(signs).toHaveValue('Sam at Northline')

  // Open memory goes to Team memory; View skills goes to the Skills page.
  await main(page).getByRole('button', { name: 'Open memory', exact: true }).click()
  await expect(h1(page, 'Team memory')).toBeVisible()
  await expect(page).toHaveURL(/#\/settings\/team-memory$/)
  await goTo(page, 'team-agent')
  await main(page).getByRole('button', { name: 'View skills', exact: true }).click()
  await expect(h1(page, 'Skills')).toBeVisible()
  await expect(page).toHaveURL(/#\/skills$/)

  await resetDemo(page)
  await goTo(page, 'team-agent')
  await expect(combo(page, 'Tone: Friendly and short')).toBeVisible()
  await expect(signs).toHaveValue('The Northline team')
})

test('Data and access: retention and access switches are saved, survive a reload and Reset demo clears them; Export and delete answer', async ({ page }) => {
  await start(page, 'Act', '#/settings/team-data')
  await expect(h1(page, 'Data and access')).toBeVisible()
  await expect(combo(page, 'Chats: 12 months')).toBeVisible()
  await expect(combo(page, 'Activity and steps: 12 months')).toBeVisible()
  await expect(sw(page, 'Inhouse team access')).toBeChecked()
  await expect(sw(page, 'Two-step sign-in')).toBeChecked()

  await combo(page, 'Chats: 12 months').click()
  await expect(page.getByRole('listbox', { name: 'Chats' }).getByRole('option')).toHaveText([/^3 months/, /^6 months/, /^12 months/, /^24 months/, /^Until deleted/])
  await page.getByRole('option', { name: '6 months' }).click()
  await expect(combo(page, 'Chats: 6 months')).toBeVisible()
  await combo(page, 'Activity and steps: 12 months').click()
  await page.getByRole('option', { name: 'Until deleted' }).click()
  await expect(combo(page, 'Activity and steps: Until deleted')).toBeVisible()
  await sw(page, 'Inhouse team access').click()
  await expect(sw(page, 'Inhouse team access')).not.toBeChecked()
  await sw(page, 'Two-step sign-in').click()
  await expect(sw(page, 'Two-step sign-in')).not.toBeChecked()
  // The audit log's own retention is a fact, not a choice: its row shows 12 months as text.
  const audit = main(page).getByText('Audit log', { exact: true }).locator('xpath=ancestor::div[contains(@class,"py-4")][1]')
  await expect(audit).toContainText('Changes to settings, rules and people. Cannot be shortened.')
  await expect(audit.getByText('12 months', { exact: true })).toBeVisible()
  await expect(audit.getByRole('combobox')).toHaveCount(0)

  await page.reload()
  await expect(combo(page, 'Chats: 6 months')).toBeVisible()
  await expect(combo(page, 'Activity and steps: Until deleted')).toBeVisible()
  await expect(sw(page, 'Inhouse team access')).not.toBeChecked()
  await expect(sw(page, 'Two-step sign-in')).not.toBeChecked()

  // Export says it isn't wired up, and changes nothing.
  await main(page).getByRole('button', { name: 'Export', exact: true }).click()
  await expect(toast(page, "Export isn't connected in this demo.")).toBeVisible()
  await expect(h1(page, 'Data and access')).toBeVisible()
  await expect(team(page)).toHaveCount(0)

  // Deleting goes through the team: the window opens on "Change something" with the request written.
  await main(page).getByRole('button', { name: 'Ask the team', exact: true }).click()
  await expect(team(page)).toBeVisible()
  await expect(team(page).getByRole('radio', { name: /Change something/ })).toBeChecked()
  await expect(team(page).getByRole('textbox', { name: 'Your request' })).toHaveValue('Please delete the Inhouse agent and its data for Northline Outdoor.')
  await page.keyboard.press('Escape')
  await expect(team(page)).toHaveCount(0)

  await resetDemo(page)
  await goTo(page, 'team-data')
  await expect(combo(page, 'Chats: 12 months')).toBeVisible()
  await expect(combo(page, 'Activity and steps: 12 months')).toBeVisible()
  await expect(sw(page, 'Inhouse team access')).toBeChecked()
  await expect(sw(page, 'Two-step sign-in')).toBeChecked()
})

test('Audit log: pausing the agent adds a row at the top that survives a reload, and Resume takes it away', async ({ page }) => {
  await start(page, 'Act', '#/settings/team-audit')
  await expect(h1(page, 'Audit log')).toBeVisible()
  const paused = main(page).getByText('Sam Mercer paused your Inhouse agent', { exact: true })
  const seeded = main(page).getByText('Sam Mercer changed an approval rule', { exact: true })
  await expect(seeded).toBeVisible()
  await expect(paused).toHaveCount(0)

  // Pause from Run limits: the log gets a row above the seeded one.
  await goTo(page, 'team-limits')
  await main(page).getByRole('button', { name: 'Pause Inhouse agent', exact: true }).click()
  await expect(page.getByRole('status', { name: 'Inhouse agent is paused' })).toBeVisible()
  await goTo(page, 'team-audit')
  await expect(paused).toBeVisible()
  await expect(main(page).getByText(/^Routines and jobs stopped\s·\s/)).toBeVisible()
  const top = async (loc: typeof paused) => (await loc.boundingBox())!.y
  expect(await top(paused)).toBeLessThan(await top(seeded))

  await page.reload()
  await expect(paused).toBeVisible()

  // Resume: the row goes, the seeded rows stay.
  await goTo(page, 'team-limits')
  await main(page).getByRole('button', { name: 'Resume Inhouse agent', exact: true }).click()
  await expect(toast(page, 'Your Inhouse agent is running again')).toBeVisible()
  await goTo(page, 'team-audit')
  await expect(paused).toHaveCount(0)
  await expect(seeded).toBeVisible()
})
