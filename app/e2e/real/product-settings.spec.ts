// The product's Settings on the test build (the product bundle, a signed-in Admin): what it leaves out because nothing reads
// it yet, where Pause and the Brand name live, and where a link to a page the product doesn't have lands. It would fail if
// the product showed Language, Text size or Two-step sign-in again, kept Who approves what or Run limits reachable by a
// link, lost the Pause button from the Spending cap page, or showed an empty brand name (the sidebar's subtitle and the
// Brand name row come from the seeded `b:name` setting).
import { expect, test } from '../support/test-build/index.js'
import type { Page } from '@playwright/test'
import { open, signInAs } from '../support/clients/real.js'
import { SEED_SETTINGS } from '../../server/seed/brand.ts'

const BRAND = String(SEED_SETTINGS.find(([, key]) => key === 'b:name')![2])
const phone = (w: number | undefined) => (w ?? 1440) < 600

test('General and Data and access leave out Language, Text size and Two-step sign-in', async ({ page, context }) => {
  await signInAs(context, 'admin')
  const main = page.getByRole('main')
  await open(page, 'admin', '#/settings/you-general')
  await expect(page.getByRole('heading', { level: 1, name: 'General', exact: true })).toBeVisible()
  await expect(main.getByText('Theme', { exact: true })).toBeVisible()
  for (const hidden of ['Language', 'Text size']) await expect(main.getByText(hidden, { exact: true })).toHaveCount(0)
  await open(page, 'admin', '#/settings/team-data')
  await expect(page.getByRole('heading', { level: 1, name: 'Data and access', exact: true })).toBeVisible()
  await expect(main.getByText('Inhouse team access', { exact: true })).toBeVisible()
  await expect(main.getByText('Two-step sign-in', { exact: true })).toHaveCount(0)
})

test('The Inhouse agent page shows the seeded brand name and leaves out Tone and Signs emails as', async ({ page, context }) => {
  await signInAs(context, 'admin')
  const main = page.getByRole('main')
  await open(page, 'admin', '#/settings/team-agent')
  await expect(page.getByRole('heading', { level: 1, name: 'Inhouse agent', exact: true })).toBeVisible()
  await expect(main.getByText('Brand name', { exact: true })).toBeVisible()
  // A phone reads a team page as text; a desktop Admin edits it in a field.
  if (phone(page.viewportSize()?.width)) await expect(main.getByText(BRAND, { exact: true })).toBeVisible()
  else {
    await expect(main.getByRole('textbox', { name: 'Brand name', exact: true })).toHaveValue(BRAND)
    await expect(page.getByRole('complementary', { name: 'Sidebar' }).getByText(BRAND, { exact: true })).toBeVisible()
  }
  for (const hidden of ['Tone', 'Signs emails as']) await expect(main.getByText(hidden, { exact: true })).toHaveCount(0)
})

test('Spending cap holds Pause Inhouse agent, and the menu has no Who approves what, Run limits or Notifications', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await open(page, 'admin', '#/settings/team-spend')
  await expect(page.getByRole('heading', { level: 1, name: 'Spending cap', exact: true })).toBeVisible()
  // The product's view is pinned to Act (Stage 1 M2-I): the button is offered. no-stages.spec.ts clicks it.
  await expect(page.getByRole('main').getByRole('button', { name: 'Pause Inhouse agent', exact: true })).toBeEnabled()
  if (phone(page.viewportSize()?.width)) await page.getByRole('button', { name: 'Back to settings' }).click()
  const nav = page.getByRole('navigation', { name: 'Settings' })
  await expect(nav.getByRole('button', { name: 'Spending cap', exact: true })).toBeVisible()
  for (const gone of ['Who approves what', 'Run limits', 'Notifications']) await expect(nav.getByRole('button', { name: gone, exact: true })).toHaveCount(0)
})

for (const tab of ['team-approvals', 'team-limits', 'you-notif']) {
  test(`A link to ${tab} lands on General and says the page doesn't exist`, async ({ page, context }) => {
    await signInAs(context, 'admin')
    await open(page, 'admin', `#/settings/${tab}`)
    await expect(page.getByRole('heading', { level: 1, name: 'General', exact: true })).toBeVisible()
    await expect(page.locator('[data-toast]').filter({ hasText: "That page doesn't exist. You're on General." })).toBeVisible()
  })
}

// M1-F: the web switches (Inhouse agent page) and the two spend fields (Spending cap page). An Admin changes them on a
// computer, a Member reads them as text, and the job budget field holds the $100 ceiling and the $0.25 start hold. It
// would fail if an Admin's switch didn't save or come back after a reload, a Member got a control, an Admin got a
// control over which websites it may open, or the job budget saved a value outside $0.25 to $100.
/**
 * The PUT a settings change sends (route 10). The page shows a change at once, before the server has it, so a test waits
 * for this answer before it reloads or moves on, never for the page alone.
 */
const savedBrand = (page: Page, key: string) =>
  page.waitForResponse(r => r.request().method() === 'PUT' && decodeURIComponent(new URL(r.url()).pathname) === `/api/settings/brand/${key}`)
    .then(r => { expect(r.status(), key).toBe(200) })

test('An Admin flips Search the web and Read web pages, and they stay after a reload', async ({ page, context }) => {
  test.skip(phone(page.viewportSize()?.width), 'a phone reads team settings as text')
  await signInAs(context, 'admin')
  const main = page.getByRole('main')
  await open(page, 'admin', '#/settings/team-agent')
  const search = main.getByRole('switch', { name: 'Search the web', exact: true })
  const read = main.getByRole('switch', { name: 'Read web pages', exact: true })
  // The defaults: search off, reading on. Which websites it may open stays the Inhouse team's: text, not a field.
  await expect(search).not.toBeChecked()
  await expect(read).toBeChecked()
  await expect(main.getByRole('textbox', { name: 'Websites it may open', exact: true })).toHaveCount(0)
  try {
    await Promise.all([savedBrand(page, 't:websearch'), search.click()])
    await expect(search).toBeChecked()
    await Promise.all([savedBrand(page, 't:webfetch_on'), read.click()])
    await expect(read).not.toBeChecked()
    await page.reload()
    await expect(search).toBeChecked()
    await expect(read).not.toBeChecked()
  } finally {
    if (await search.isChecked()) await Promise.all([savedBrand(page, 't:websearch'), search.click()])
    if (!(await read.isChecked())) await Promise.all([savedBrand(page, 't:webfetch_on'), read.click()])
    await expect(search).not.toBeChecked()
    await expect(read).toBeChecked()
  }
})

test('An Admin sets the job budget between $0.25 and $100 next to the one Monthly cap', async ({ page, context }) => {
  test.skip(phone(page.viewportSize()?.width), 'a phone reads team settings as text')
  await signInAs(context, 'admin')
  const main = page.getByRole('main')
  await open(page, 'admin', '#/settings/team-spend')
  await expect(main.getByRole('textbox', { name: 'Monthly cap', exact: true })).toHaveCount(1)
  const job = main.getByRole('textbox', { name: 'Job budget', exact: true })
  await expect(job).toHaveValue('$25')
  let moved = false
  try {
    for (const over of ['$150', '0.10']) {
      await job.fill(over)
      await job.press('Enter')
      await expect(main.getByText('Enter an amount from $0.25 to $100.', { exact: true })).toBeVisible()
    }
    await job.fill('60')
    await Promise.all([savedBrand(page, 's:job_cap'), job.press('Enter')])
    moved = true
    await expect(job).toHaveValue('$60')
    await expect(page.locator('[data-toast]').filter({ hasText: 'Saved' })).toBeVisible()
    await page.reload()
    await expect(job).toHaveValue('$60')
  } finally {
    // Put back only what was saved (an unchanged value sends no PUT to wait for).
    if (moved) {
      await job.fill('$25')
      await Promise.all([savedBrand(page, 's:job_cap'), job.press('Enter')])
      await expect(job).toHaveValue('$25')
    }
  }
})

test('A Member reads the web switches and both spend fields as text, with no control', async ({ page, context }) => {
  await signInAs(context, 'dana')
  const main = page.getByRole('main')
  await open(page, 'dana', '#/settings/team-agent')
  await expect(page.getByRole('heading', { level: 1, name: 'Inhouse agent', exact: true })).toBeVisible()
  for (const name of ['Search the web', 'Read web pages']) {
    await expect(main.getByText(name, { exact: true })).toBeVisible()
    await expect(main.getByRole('switch', { name, exact: true })).toHaveCount(0)
  }
  await open(page, 'dana', '#/settings/team-spend')
  await expect(page.getByRole('heading', { level: 1, name: 'Spending cap', exact: true })).toBeVisible()
  await expect(main.getByText('Job budget', { exact: true })).toBeVisible()
  await expect(main.getByText('$25', { exact: true })).toBeVisible()
  for (const name of ['Monthly cap', 'Job budget']) await expect(main.getByRole('textbox', { name, exact: true })).toHaveCount(0)
})

// #754: the Inhouse team chooses how far reading web pages reaches on the Inhouse agent page. It can choose a list saved empty
// (no website) on purpose, from a brand with no list saved, and go back to any public website. It would fail if the choice
// saved nothing (the bug: a field left empty never saved, so a brand with no list couldn't be blocked from the screen).
test('The Inhouse team picks any public website or only the websites listed, and an empty list blocks all', async ({ page, context }) => {
  test.skip(phone(page.viewportSize()?.width), 'a phone reads team settings as text')
  await signInAs(context, 'inhouse')
  const main = page.getByRole('main')
  await open(page, 'inhouse', '#/settings/team-agent')
  const choice = (value: string) => main.getByRole('combobox', { name: `Websites it may open: ${value}`, exact: true })
  const list = main.getByRole('textbox', { name: 'Websites it may open', exact: true })
  const saved = () => page.waitForResponse(r => r.request().method() === 'PUT' && decodeURIComponent(new URL(r.url()).pathname).endsWith('/t:webfetch')).then(r => { expect(r.status()).toBe(200) })
  // The seeded brand has a list saved: only those websites.
  await expect(choice('Only the websites listed')).toBeVisible()
  await expect(list).toHaveValue('example.com')
  try {
    // Going back to any public website asks first, because it clears the list; then there is no list to show.
    await choice('Only the websites listed').click()
    await page.getByRole('option', { name: 'Any public website', exact: true }).click()
    await Promise.all([saved(), page.getByRole('dialog', { name: 'Allow any public website?' }).getByRole('button', { name: 'Allow any website', exact: true }).click()])
    await expect(choice('Any public website')).toBeVisible()
    await expect(list).toHaveCount(0)
    // From a brand with no list saved, choosing the list saves it empty: it blocks every website, and it stays after a reload.
    await choice('Any public website').click()
    await Promise.all([saved(), page.getByRole('option', { name: 'Only the websites listed', exact: true }).click()])
    await expect(choice('Only the websites listed')).toBeVisible()
    await expect(list).toHaveValue('')
    await page.reload()
    await expect(choice('Only the websites listed')).toBeVisible()
    await expect(list).toHaveValue('')
  } finally {
    // Put the seeded list back: choose the list if it isn't chosen, then type it.
    if (await choice('Any public website').count()) {
      await choice('Any public website').click()
      await Promise.all([saved(), page.getByRole('option', { name: 'Only the websites listed', exact: true }).click()])
    }
    // An unchanged list sends no PUT to wait for (the field skips it), so type and wait only when it differs.
    if ((await list.inputValue()) !== 'example.com') {
      await list.fill('example.com')
      await Promise.all([saved(), list.blur()])
    }
    await expect(list).toHaveValue('example.com')
  }
})
