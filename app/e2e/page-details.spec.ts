// Page actions: a routine's details and actions, a skill's on switch, Library sort, row menu and
// viewer stepping, and Settings' Admin confirm and field checks. Each flow reloads to prove what was saved.
import { expect, test, type Fx, type Stage } from './support/fx.js'
import type { Page } from '@playwright/test'
import { atRest } from './states.js'

async function start(page: Page, fx: Fx, hash: string, stage: Stage = 'Act') {
  await fx.seed({ stage, demo: { ambient: 'Always' } })
  await page.goto('/?demo' + hash)
}
const shot = async (page: Page, name: string) => { await atRest(page); await page.screenshot({ path: test.info().outputPath(`${name}.png`) }) }
const toast = (page: Page, text: string) => page.locator('[data-toast]').filter({ hasText: text })

test('Routines: details, Pause, Run now, Delete with confirm and Undo, and all of it survives a reload', async ({ fx, page }) => {
  await start(page, fx, '#/routines')
  await expect(page.getByRole('heading', { level: 1, name: 'Routines' })).toBeVisible()
  const name = 'Amazon payout check'
  const sw = page.getByRole('switch', { name: `${name} on or off` })
  await expect(sw).toBeChecked()

  // The row opens its details: schedule, what it does, last runs and the actions.
  await page.getByRole('button', { name, exact: true }).click()
  let sheet = page.getByRole('dialog', { name })
  await expect(sheet).toBeVisible()
  await expect(sheet).toContainText('Compares each Amazon payout with what Xero expected.')
  await expect(sheet).toContainText('Every day at 6:00 AM')
  await expect(sheet.getByRole('list', { name: 'Last runs' })).toContainText('found a $1,240 gap')
  await shot(page, 'routine-sheet')

  // Pause from the sheet: the toast says so and the sheet offers Resume.
  await sheet.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(toast(page, `Paused ${name}`)).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Resume', exact: true })).toBeVisible()

  // Run now adds a line at the top of the last runs.
  await sheet.getByRole('button', { name: 'Run now' }).click()
  await expect(toast(page, `${name} is running now`)).toBeVisible()
  await expect(sheet.getByRole('list', { name: 'Last runs' }).getByRole('listitem').first()).toContainText('Run now')
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  // Focus goes back to the row that opened the sheet.
  await expect(page.getByRole('button', { name, exact: true })).toBeFocused()
  await expect(sw).not.toBeChecked()
  // The Close button gives focus back too.
  await page.getByRole('button', { name: 'Monday reorder list', exact: true }).click()
  await page.getByRole('dialog', { name: 'Monday reorder list' }).getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Monday reorder list', exact: true })).toBeFocused()

  // A Morning check run links to its steps.
  await page.getByRole('button', { name: 'Morning check', exact: true }).click()
  sheet = page.getByRole('dialog', { name: 'Morning check' })
  await sheet.getByRole('button', { name: 'Steps →' }).first().click()
  await expect(page.getByRole('dialog', { name: /What your Inhouse agent did/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // Delete from the row menu asks first; Cancel keeps it, Delete removes it, Undo brings it back.
  const actions = page.getByRole('button', { name: `Actions for ${name}` })
  await actions.click()
  await page.getByRole('menu', { name: 'Routine actions' }).getByRole('menuitem', { name: 'Delete' }).click()
  const ask = page.getByRole('dialog', { name: 'Delete routine' })
  await expect(ask).toContainText(`Delete ${name}?`)
  await shot(page, 'routine-delete-confirm')
  await ask.getByRole('button', { name: 'Cancel' }).click()
  await expect(ask).toHaveCount(0)
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
  await actions.click()
  await page.getByRole('menu', { name: 'Routine actions' }).getByRole('menuitem', { name: 'Delete' }).click()
  await page.getByRole('dialog', { name: 'Delete routine' }).getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0)
  await toast(page, `Deleted ${name}`).getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible()

  // Delete another one for good, then reload: the pause, the run and the delete were all saved.
  await page.getByRole('button', { name: 'Actions for Weekly numbers report' }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await page.getByRole('dialog', { name: 'Delete routine' }).getByRole('button', { name: 'Delete', exact: true }).click()
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Routines' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Weekly numbers report', exact: true })).toHaveCount(0)
  await expect(page.getByRole('switch', { name: `${name} on or off` })).not.toBeChecked()
  await page.getByRole('button', { name, exact: true }).click()
  await expect(page.getByRole('dialog', { name }).getByRole('list', { name: 'Last runs' }).getByRole('listitem').first()).toContainText('Run now')
  await shot(page, 'routine-after-reload')
})

test('Routines in Watch: a locked routine shows its stage and no actions', async ({ fx, page }) => {
  await start(page, fx, '#/routines', 'Watch')
  await expect(page.getByRole('button', { name: 'Actions for Morning check' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Actions for Amazon payout check' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Amazon payout check', exact: true }).click()
  const sheet = page.getByRole('dialog', { name: 'Amazon payout check' })
  await expect(sheet).toContainText('Starts in Act')
  await expect(sheet.getByRole('button', { name: 'Run now' })).toHaveCount(0)
})

test('Skills: turn a skill off in its details and back on', async ({ fx, page }) => {
  await start(page, fx, '#/skills')
  const name = 'Reorder drafting'
  await page.getByRole('button', { name, exact: true }).click()
  const sheet = page.getByRole('dialog', { name })
  await expect(sheet).toContainText("Works out how much to reorder and drafts the PO in the supplier's format.")
  await expect(sheet).toContainText('12 times')
  const sw = sheet.getByRole('switch', { name: `${name} on or off` })
  await expect(sw).toBeChecked()
  await sw.click()
  await expect(sw).not.toBeChecked()
  await expect(sheet).toContainText("won't use this skill")
  await shot(page, 'skill-sheet-off')
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  // Focus goes back to the row that opened the sheet.
  await expect(page.getByRole('button', { name, exact: true })).toBeFocused()
  // The row says it's off, and stays so after a reload.
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Skills' })).toBeVisible()
  const row = page.getByRole('button', { name, exact: true }).locator('xpath=..')
  await expect(row).toContainText('Off')
  await page.getByRole('button', { name, exact: true }).click()
  await page.getByRole('dialog', { name }).getByRole('switch', { name: `${name} on or off` }).click()
  await expect(page.getByRole('dialog', { name }).getByRole('switch', { name: `${name} on or off` })).toBeChecked()
  await page.keyboard.press('Escape')
  await expect(row).not.toContainText('Off')
})

const cards = (page: Page) => page.getByRole('list', { name: 'Files' }).getByRole('listitem')
/** Each card's file name, read from its menu button ("Actions for <name>"). */
const names = (page: Page) => cards(page).getByRole('button', { name: /^Actions for / })
  .evaluateAll(els => els.map(e => e.getAttribute('aria-label')!.replace(/^Actions for /, '')))

test('Library: sort by name, delete from a row menu with Undo, step the viewer with the arrow keys in a tab', async ({ fx, page }) => {
  await start(page, fx, '#/library')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('All files')
  const total = await cards(page).count()

  // Sort by name, in every view.
  await page.getByRole('combobox', { name: 'Sort: Newest' }).click()
  await page.getByRole('option', { name: 'Name' }).click()
  const byName = await names(page)
  expect(byName).toHaveLength(total)
  // Known first and last names from the sample data, not the page's own comparator.
  expect(byName.slice(0, 3)).toEqual(['amazon-fee-breakdown.csv', 'amazon-fee-reimbursement-case.pdf', 'amazon-payout-check.csv'])
  expect(byName.slice(-3)).toEqual(['weekly-numbers-week-46.xlsx', 'weekly-ops-report-week-45.pdf', 'weekly-ops-report-week-46.pdf'])
  await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: 'List' }).click()
  expect(await names(page)).toEqual(byName)
  await shot(page, 'library-list-by-name')

  // Delete one file from its row menu; Undo brings it back.
  const victim = 'amazon-payout-check.csv'
  const row = cards(page).filter({ hasText: victim })
  await row.hover()
  await row.getByRole('button', { name: `Actions for ${victim}` }).click()
  const menu = page.getByRole('menu', { name: 'File actions' })
  // Each item's name, not its text: the icon glyph is part of the text but hidden from the name.
  const items = menu.getByRole('menuitem')
  await expect(items).toHaveCount(4)
  for (const [i, n] of ['Open', 'Download', 'Open Routines', 'Delete'].entries()) await expect(items.nth(i)).toHaveAccessibleName(n)
  await shot(page, 'library-row-menu')
  await menu.getByRole('menuitem', { name: 'Delete' }).click()
  await expect(cards(page)).toHaveCount(total - 1)
  await expect(cards(page).filter({ hasText: victim })).toHaveCount(0)
  // Focus moves to the next file in the list.
  const next = byName[byName.indexOf(victim) + 1]
  await expect(cards(page).filter({ hasText: next }).getByRole('button').first()).toBeFocused()
  await toast(page, 'Deleted 1 file').getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(cards(page)).toHaveCount(total)

  // Sort with a search: only the matches, in each sort's order.
  const search = page.getByRole('searchbox', { name: 'Search library' })
  await search.fill('week-4')
  expect(await names(page)).toEqual(['returns-summary-week-46.pdf', 'weekly-numbers-week-46.xlsx', 'weekly-ops-report-week-45.pdf', 'weekly-ops-report-week-46.pdf'])
  await page.getByRole('combobox', { name: 'Sort: Name' }).click()
  await page.getByRole('option', { name: 'Size' }).click()
  expect(await names(page)).toEqual(['weekly-ops-report-week-46.pdf', 'weekly-ops-report-week-45.pdf', 'returns-summary-week-46.pdf', 'weekly-numbers-week-46.xlsx'])
  await page.getByRole('combobox', { name: 'Sort: Size' }).click()
  await page.getByRole('option', { name: 'Oldest' }).click()
  expect(await names(page)).toEqual(['weekly-ops-report-week-45.pdf', 'weekly-ops-report-week-46.pdf', 'returns-summary-week-46.pdf', 'weekly-numbers-week-46.xlsx'])
  await search.fill('')
  await page.getByRole('combobox', { name: 'Sort: Oldest' }).click()
  await page.getByRole('option', { name: 'Name' }).click()

  // The viewer steps through the Code tab, in name order, and stops at either end.
  await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: 'Masonry' }).click()
  await page.getByRole('radiogroup', { name: 'File type' }).getByRole('radio', { name: /^Code \d+$/ }).click()
  const code = await names(page)
  expect(code.length).toBeGreaterThanOrEqual(3)
  await cards(page).filter({ hasText: code[0] }).click()
  const viewer = (n: string) => page.getByRole('dialog', { name: `File: ${n}` })
  await expect(viewer(code[0])).toBeVisible()
  await expect(viewer(code[0]).getByRole('button', { name: 'Previous file' })).toBeDisabled()
  for (const n of code.slice(1)) {
    await page.keyboard.press('ArrowRight')
    await expect(viewer(n)).toBeVisible()
  }
  const last = code[code.length - 1]
  await expect(viewer(last).getByRole('button', { name: 'Next file' })).toBeDisabled()
  await page.keyboard.press('ArrowRight')
  await expect(viewer(last)).toBeVisible()
  await shot(page, 'library-viewer-last-code-file')
  await page.keyboard.press('ArrowLeft')
  await expect(viewer(code[code.length - 2])).toBeVisible()
  await viewer(code[code.length - 2]).getByRole('button', { name: 'Previous file' }).click()
  await expect(viewer(code[code.length - 3])).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('Settings: removing Admin asks first and Cancel keeps it; a wrong Monthly cap shows why and isn\'t saved', async ({ fx, page }) => {
  await page.clock.install() // time keeps flowing; runFor adds app time on top, so no real sleep
  await start(page, fx, '#/settings/team-members')
  await page.getByRole('combobox', { name: 'Sam Mercer: Admin' }).click()
  await page.getByRole('option', { name: 'Approver' }).click()
  const ask = page.getByRole('dialog', { name: 'Remove your admin role?' })
  await expect(ask).toBeVisible()
  await shot(page, 'settings-remove-admin')
  await ask.getByRole('button', { name: 'Cancel' }).click()
  await expect(ask).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'Sam Mercer: Admin' })).toBeVisible()
  // Escape cancels too; a change that keeps Admin elsewhere asks nothing.
  await page.getByRole('combobox', { name: 'Sam Mercer: Admin' }).click()
  await page.getByRole('option', { name: 'Member' }).click()
  await expect(page.getByRole('dialog', { name: 'Remove your admin role?' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'Sam Mercer: Admin' })).toBeVisible()
  await page.getByRole('combobox', { name: 'Leo Park: Approver' }).click()
  await page.getByRole('option', { name: 'Admin' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'Leo Park: Admin' })).toBeVisible()

  await page.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'Spending cap' }).click()
  const cap = page.getByRole('textbox', { name: 'Monthly cap' })
  const before = await cap.inputValue()
  await cap.fill('lots')
  await cap.blur()
  await expect(page.getByText('Enter an amount above $0, like $300.')).toBeVisible()
  await expect(cap).toHaveAttribute('aria-invalid', 'true')
  await expect(toast(page, 'Saved')).toHaveCount(0)
  await shot(page, 'settings-cap-error')
  await page.reload()
  await expect(page.getByRole('textbox', { name: 'Monthly cap' })).toHaveValue(before)
  await page.getByRole('textbox', { name: 'Monthly cap' }).fill('-5')
  await page.getByRole('textbox', { name: 'Monthly cap' }).blur()
  await expect(page.getByText('Enter an amount above $0, like $300.')).toBeVisible()
  await page.getByRole('textbox', { name: 'Monthly cap' }).fill('320')
  await expect(page.getByText('Enter an amount above $0, like $300.')).toHaveCount(0)
  await page.getByRole('textbox', { name: 'Monthly cap' }).blur()
  await expect(toast(page, 'Saved')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Monthly cap' })).toHaveValue('$320')
  await page.reload()
  await expect(page.getByRole('textbox', { name: 'Monthly cap' })).toHaveValue('$320')

  // Exponents, hex and absurd amounts are refused; Enter saves like leaving the field, in a tidy two-decimal form.
  const field = page.getByRole('textbox', { name: 'Monthly cap' })
  for (const bad of ['1e3', '0x10', '300.555']) {
    await field.fill(bad)
    await field.press('Enter')
    await expect(page.getByText('Enter an amount above $0, like $300.')).toBeVisible()
  }
  await field.fill('5000000')
  await field.press('Enter')
  await expect(page.getByText('Enter an amount up to $100,000.')).toBeVisible()
  await field.fill('1,300.5')
  await field.press('Enter')
  await expect(field).toHaveValue('$1300.50')
  await expect(field).toBeFocused()
  await expect(toast(page, 'Saved')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('textbox', { name: 'Monthly cap' })).toHaveValue('$1300.50')

  // A plain field's "Saved" waits for typing to stop, and doesn't follow the person off the page.
  await page.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'Inhouse agent' }).click()
  await page.getByRole('textbox', { name: 'Signs emails as' }).fill('Sam at Northline')
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Today/ }).click()
  await page.clock.runFor(1000) // past the 600 ms typing pause, when "Saved" would show
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/need you|left to approve/) // Today is drawn
  await expect(toast(page, 'Saved')).toHaveCount(0)
})

test('Library: deleting the last search match moves focus to the search box', async ({ fx, page }) => {
  await start(page, fx, '#/library')
  const victim = 'kestrel-delivery-times.png'
  const search = page.getByRole('searchbox', { name: 'Search library' })
  await search.fill(victim)
  await expect(cards(page)).toHaveCount(1)
  const row = cards(page).filter({ hasText: victim })
  await row.hover()
  await row.getByRole('button', { name: `Actions for ${victim}` }).click()
  await page.getByRole('menu', { name: 'File actions' }).getByRole('menuitem', { name: 'Delete' }).click()
  await expect(page.getByText(`No files match "${victim}".`)).toBeVisible()
  await expect(search).toBeFocused()
})

test('Routines: Cancel on a delete asked from the details gives focus back to the routine row', async ({ fx, page }) => {
  await start(page, fx, '#/routines')
  const name = 'Monday reorder list'
  const open = page.getByRole('button', { name, exact: true })
  await open.click()
  await page.getByRole('dialog', { name }).getByRole('button', { name: 'Delete' }).click()
  const ask = page.getByRole('dialog', { name: 'Delete routine' })
  await expect(ask).toContainText(`Delete ${name}?`)
  await ask.getByRole('button', { name: 'Cancel' }).click()
  await expect(ask).toHaveCount(0)
  await expect(open).toBeFocused()
})
