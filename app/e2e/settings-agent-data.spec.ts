// Settings > Inhouse agent, Data and access and Audit log (desktop: on a phone these team pages are read-only, see
// settings-pages-phone.spec.ts). Each control does what it says; the picks the app keeps survive a reload and Reset demo
// clears them. The audit log's download is checked in sample-data.spec.ts.
import { readFileSync } from 'node:fs'
import { expect, test, type Fx } from './support/fx.js'
import type { Page } from '@playwright/test'

type Stage = 'Watch' | 'Act' | 'Run'

async function start(page: Page, fx: Fx, stage: Stage, hash: string) {
  await fx.seed({ stage })
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

test('Inhouse agent: brand name, tone and sign-off are saved, survive a reload and Reset demo clears them; its links open Team memory and Skills', async ({ fx, page }) => {
  await start(page, fx, 'Act', '#/settings/team-agent')
  await expect(h1(page, 'Inhouse agent')).toBeVisible()
  const signs = main(page).getByRole('textbox', { name: 'Signs emails as', exact: true })
  const brand = main(page).getByRole('textbox', { name: 'Brand name', exact: true })
  await expect(combo(page, 'Tone: Friendly and short')).toBeVisible()
  await expect(signs).toHaveValue('The Northline team')
  await expect(brand).toHaveValue('Northline Outdoor')

  await combo(page, 'Tone: Friendly and short').click()
  await expect(page.getByRole('listbox', { name: 'Tone' }).getByRole('option')).toHaveText([/^Friendly and short(\s*check)?$/, /^Warm and detailed(\s*check)?$/, /^Formal and brief(\s*check)?$/, /^Plain and direct(\s*check)?$/])
  await page.getByRole('option', { name: 'Formal and brief' }).click()
  await expect(combo(page, 'Tone: Formal and brief')).toBeVisible()
  await signs.fill('Sam at Northline')
  await expect(toast(page, 'Saved')).toBeVisible()
  await brand.fill('Northline Trail')

  await page.reload()
  await expect(combo(page, 'Tone: Formal and brief')).toBeVisible()
  await expect(signs).toHaveValue('Sam at Northline')
  await expect(brand).toHaveValue('Northline Trail')

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
  await expect(brand).toHaveValue('Northline Outdoor')
})

test('Data and access: retention and access switches are saved, survive a reload and Reset demo clears them; Next cleanup shows; Export downloads a sample and delete answers', async ({ fx, page }) => {
  await start(page, fx, 'Act', '#/settings/team-data')
  await expect(h1(page, 'Data and access')).toBeVisible()
  await expect(combo(page, 'Chats: 12 months')).toBeVisible()
  await expect(combo(page, 'Activity and steps: 12 months')).toBeVisible()
  await expect(sw(page, 'Inhouse team access')).toBeChecked()
  await expect(sw(page, 'Two-step sign-in')).toBeChecked()

  await combo(page, 'Chats: 12 months').click()
  await expect(page.getByRole('listbox', { name: 'Chats' }).getByRole('option')).toHaveText([/^3 months(\s*check)?$/, /^6 months(\s*check)?$/, /^12 months(\s*check)?$/, /^24 months(\s*check)?$/, /^Until deleted(\s*check)?$/])
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
  // The row: the innermost block holding its label and the 12 months (no styling classes), not the card around every row.
  const audit = main(page).locator('div').filter({ has: page.getByText('Audit log', { exact: true }) }).filter({ hasText: '12 months' }).last()
  await expect(audit).not.toContainText('Chats')
  await expect(audit).toContainText('Changes to settings, rules and people. Cannot be shortened.')
  await expect(audit.getByText('12 months', { exact: true })).toBeVisible()
  await expect(audit.getByRole('combobox')).toHaveCount(0)

  await page.reload()
  await expect(combo(page, 'Chats: 6 months')).toBeVisible()
  await expect(combo(page, 'Activity and steps: Until deleted')).toBeVisible()
  await expect(sw(page, 'Inhouse team access')).not.toBeChecked()
  await expect(sw(page, 'Two-step sign-in')).not.toBeChecked()

  // Next cleanup says when the nightly cleanup runs next (03:30 UTC, in the brand's time).
  await expect(main(page).getByText('Next cleanup', { exact: true })).toBeVisible()
  await expect(main(page).getByText(/^(Today|[A-Z][a-z]{2}, .+) at \d{1,2}:\d{2}\s?[AP]M$/)).toBeVisible()

  // Export downloads the demo's invented sample, in the product export's shape, and changes nothing.
  const [file] = await Promise.all([page.waitForEvent('download'), main(page).getByRole('button', { name: 'Export', exact: true }).click()])
  expect(file.suggestedFilename()).toMatch(/^inhouse-export-\d{4}-\d{2}-\d{2}\.ndjson$/)
  const sample = readFileSync(await file.path(), 'utf8').trimEnd().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
  expect(sample[0]).toMatchObject({ format: 1, kind: 'brand', sample: true })
  expect(sample.at(-1)).toMatchObject({ end: true })
  await expect(toast(page, 'Sample export downloaded. The demo uses invented data.')).toBeVisible()
  await expect(h1(page, 'Data and access')).toBeVisible()
  await expect(team(page)).toHaveCount(0)

  // Deleting goes through the team: the window opens on "Change something" with the request written.
  await main(page).getByRole('button', { name: 'Ask the team', exact: true }).click()
  await expect(team(page)).toBeVisible()
  await expect(team(page).getByRole('radio', { name: /Change something/ })).toBeChecked()
  await expect(team(page).getByRole('textbox', { name: 'Details' })).toHaveValue('Please delete the Inhouse agent and its data for Northline Outdoor.')
  await page.keyboard.press('Escape')
  await expect(team(page)).toHaveCount(0)

  await resetDemo(page)
  await goTo(page, 'team-data')
  await expect(combo(page, 'Chats: 12 months')).toBeVisible()
  await expect(combo(page, 'Activity and steps: 12 months')).toBeVisible()
  await expect(sw(page, 'Inhouse team access')).toBeChecked()
  await expect(sw(page, 'Two-step sign-in')).toBeChecked()
})

test('Audit log: pausing the agent adds a row at the top that survives a reload, and Resume takes it away', async ({ fx, page }) => {
  await start(page, fx, 'Act', '#/settings/team-audit')
  await expect(h1(page, 'Audit log')).toBeVisible()
  const paused = main(page).getByText('Sam Mercer paused your Inhouse agent', { exact: true })
  const seeded = main(page).getByText('Sam Mercer changed an approval rule', { exact: true })
  await expect(seeded).toBeVisible()
  await expect(paused).toHaveCount(0)

  // Pause from Spending cap: the log gets a row above the seeded one.
  await goTo(page, 'team-spend')
  await main(page).getByRole('button', { name: 'Pause Inhouse agent', exact: true }).click()
  await expect(page.getByRole('status', { name: 'Inhouse agent is paused' })).toBeVisible()
  await goTo(page, 'team-audit')
  await expect(paused).toBeVisible()
  await expect(main(page).getByText(/^Chats, routines and jobs stopped\s·\s/)).toBeVisible()
  const top = async (loc: typeof paused) => (await loc.boundingBox())!.y
  expect(await top(paused)).toBeLessThan(await top(seeded))

  await page.reload()
  await expect(paused).toBeVisible()

  // Resume: the row goes, the seeded rows stay.
  await goTo(page, 'team-spend')
  await main(page).getByRole('button', { name: 'Resume Inhouse agent', exact: true }).click()
  await expect(toast(page, 'Your Inhouse agent is running again')).toBeVisible()
  await goTo(page, 'team-audit')
  await expect(paused).toHaveCount(0)
  await expect(seeded).toBeVisible()
})
