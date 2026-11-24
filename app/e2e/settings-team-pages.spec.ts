// Settings > Stage and plan, Team memory and Run limits (desktop: on a phone these team pages are read-only). Each
// control does what it says; the picks the app keeps (forgotten lines, switches, dropdowns, pause) survive a reload and
// Reset demo clears them. Stage and plan keeps nothing: it shows the stage and opens the team window.
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
/** The settings row with this title (a locked row's title carries a stage tag, so it isn't matched by exact text). */
const row = (page: Page, title: string) => main(page).getByText(title, { exact: true }).locator('xpath=ancestor::div[contains(@class,"py-4")][1]')

/** Reset demo (Act and Normal come back, Today opens), then the Stage switch to this stage. */
async function resetDemo(page: Page, stage: Stage) {
  await page.getByRole('button', { name: /Demo switches/ }).click()
  const switches = page.getByRole('dialog', { name: 'Demo switches' })
  await switches.getByRole('button', { name: 'Reset demo' }).click()
  await expect(page.getByRole('heading', { level: 1 }).first()).toContainText('things need you')
  await switches.getByRole('radio', { name: stage, exact: true }).click()
  await page.getByRole('button', { name: 'Close demo switches' }).click()
}

const STAGE_ROWS: [Stage, string, string | RegExp, string][] = [
  ['Watch', 'Watch: your Inhouse agent reads every tool and changes nothing.', /Act adds /, 'Act'],
  ['Act', 'Act: your Inhouse agent does real work, and each piece waits for approval.', 'Run adds agreed jobs it finishes by itself, within your limits.', 'Run'],
  ['Run', 'Run: your Inhouse agent handles agreed jobs by itself, within your limits.', 'You have every stage. Money and customer actions still wait for a person.', 'None'],
]
for (const [stage, current, next, nextName] of STAGE_ROWS) {
  test(`Stage and plan at ${stage}: names the stage and the next one, and Book a check-in opens the team window`, async ({ fx, page }) => {
    await start(page, fx, stage, '#/settings/team-plan')
    await expect(page.getByRole('heading', { level: 1, name: 'Stage and plan', exact: true })).toBeVisible()
    await expect(row(page, 'Current stage')).toContainText(current)
    await expect(row(page, 'Current stage').getByText(stage, { exact: true })).toBeVisible()
    await expect(row(page, 'Next stage')).toContainText(next)
    await expect(row(page, 'Next stage').getByText(nextName, { exact: true })).toBeVisible()
    await expect(row(page, 'AI and hosting')).toContainText('Anthropic · Cloudflare')

    // The check-in button opens the team window on "Change something", with an empty request.
    await main(page).getByRole('button', { name: 'Book a check-in', exact: true }).click()
    const team = page.getByRole('dialog', { name: 'Your Inhouse team' })
    await expect(team).toBeVisible()
    await expect(team.getByRole('radio', { name: /Change something/ })).toBeChecked()
    await expect(team.getByRole('textbox', { name: 'Details' })).toHaveValue('')
    await page.keyboard.press('Escape')
    await expect(team).toHaveCount(0)
  })
}

test('Team memory at Watch: the lines, rule switch and Teach are available', async ({ fx, page }) => {
  await start(page, fx, 'Watch', '#/settings/team-memory')
  await expect(main(page).getByText('Kestrel Supply ships in 14 days and wants purchase orders as a PDF.')).toBeVisible()
  const forgets = main(page).getByRole('button', { name: 'Forget', exact: true })
  await expect(forgets).toHaveCount(7)
  for (const forget of await forgets.all()) await expect(forget).toBeEnabled()
  await expect(main(page).getByRole('switch', { name: 'Ask before saving a team rule' })).toBeEnabled()
  await expect(main(page).getByRole('button', { name: 'Teach in a chat', exact: true })).toBeEnabled()
})

test('Team memory: Forget (with Undo) and the rule switch work, survive a reload and Reset demo clears them; Teach in a chat opens a chat', async ({ fx, page }) => {
  await start(page, fx, 'Act', '#/settings/team-memory')
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
  await resetDemo(page, 'Act')
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

const JOBS = ['Restock returns', 'Chase late suppliers', 'Nudge ShipBob on stuck orders', 'Pause oversold variants']

test('Run limits at Act: the job switches and limits are locked until Run, and Pause (now on Spending cap) still works', async ({ fx, page }) => {
  await start(page, fx, 'Act', '#/settings/team-limits')
  for (const job of JOBS) await expect(main(page).getByRole('switch', { name: job, exact: true })).toBeDisabled()
  await expect(main(page).getByRole('combobox', { name: /^Daily limit: / })).toBeDisabled()
  await expect(main(page).getByRole('combobox', { name: /^Largest restock: / })).toBeDisabled()
  // Pause moved to the page that keeps the Spending cap: Run limits no longer has it.
  await expect(main(page).getByRole('button', { name: 'Pause Inhouse agent', exact: true })).toHaveCount(0)
  await goTo(page, 'team-spend')
  await expect(main(page).getByRole('button', { name: 'Pause Inhouse agent', exact: true })).toBeEnabled()
})

test('Run limits and Spending cap: switches, limits and Pause work, survive a reload and Reset demo clears them', async ({ fx, page }) => {
  await start(page, fx, 'Run', '#/settings/team-limits')
  const job = (name: string) => main(page).getByRole('switch', { name, exact: true })
  const daily = (value: string) => main(page).getByRole('combobox', { name: `Daily limit: ${value}`, exact: true })
  const restock = (value: string) => main(page).getByRole('combobox', { name: `Largest restock: ${value}`, exact: true })
  const status = (what: 'paused' | 'running') => page.getByRole('status', { name: `Inhouse agent is ${what}`, exact: true })
  const pause = main(page).getByRole('button', { name: 'Pause Inhouse agent', exact: true })
  const resume = main(page).getByRole('button', { name: 'Resume Inhouse agent', exact: true })

  // The defaults: every job on, 25 actions a day, restocks up to 50 units, running.
  for (const name of JOBS) await expect(job(name)).toBeChecked()
  await expect(daily('25 actions')).toBeVisible()
  await expect(restock('50 units')).toBeVisible()
  await expect(status('running')).toBeVisible()

  // One switch off leaves the others on.
  await job('Chase late suppliers').click()
  await expect(job('Chase late suppliers')).not.toBeChecked()
  for (const name of JOBS.filter(n => n !== 'Chase late suppliers')) await expect(job(name)).toBeChecked()

  // The limit lists hold their options, and a pick shows.
  await daily('25 actions').click()
  await expect(page.getByRole('listbox', { name: 'Daily limit' }).getByRole('option')).toHaveText([/^10 actions/, /^25 actions/, /^50 actions/, /^100 actions/, /^200 actions/])
  await page.getByRole('option', { name: '100 actions', exact: true }).click()
  await expect(daily('100 actions')).toBeVisible()
  await restock('50 units').click()
  await expect(page.getByRole('listbox', { name: 'Largest restock' }).getByRole('option')).toHaveText([/^25 units/, /^50 units/, /^100 units/, /^250 units/, /^500 units/])
  await page.getByRole('option', { name: '250 units', exact: true }).click()
  await expect(restock('250 units')).toBeVisible()

  // Pause (on the Spending cap page) stops the agent, says so in the top bar and flips the button; Resume undoes it.
  await goTo(page, 'team-spend')
  await pause.click()
  await expect(toast(page, 'Your Inhouse agent is paused. Chats, routines and jobs are stopped.')).toBeVisible()
  await expect(resume).toBeVisible()
  await expect(status('paused')).toBeVisible()
  await resume.click()
  await expect(toast(page, 'Your Inhouse agent is running again')).toBeVisible()
  await expect(pause).toBeVisible()
  await expect(status('running')).toBeVisible()
  await pause.click()
  await expect(status('paused')).toBeVisible()

  // Everything survives a reload, the pause included.
  await page.reload()
  await expect(resume).toBeVisible()
  await expect(status('paused')).toBeVisible()
  await goTo(page, 'team-limits')
  await expect(job('Chase late suppliers')).not.toBeChecked()
  await expect(job('Restock returns')).toBeChecked()
  await expect(daily('100 actions')).toBeVisible()
  await expect(restock('250 units')).toBeVisible()

  // Reset demo puts every default back, and a reload keeps them.
  await resetDemo(page, 'Run')
  await goTo(page, 'team-limits')
  for (const name of JOBS) await expect(job(name)).toBeChecked()
  await expect(daily('25 actions')).toBeVisible()
  await expect(restock('50 units')).toBeVisible()
  await goTo(page, 'team-spend')
  await expect(pause).toBeVisible()
  await expect(status('running')).toBeVisible()
  await goTo(page, 'team-limits')
  await page.reload()
  await expect(daily('25 actions')).toBeVisible()
  await expect(job('Chase late suppliers')).toBeChecked()
})
