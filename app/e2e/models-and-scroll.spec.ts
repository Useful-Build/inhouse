// The four models, the Models settings page, and scrolling that keeps side menus put.
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

async function start(page: Page, hash = '#/today') {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-seeded')) return
    localStorage.clear()
    localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: 'Act', scenario: 'Normal', ambient: 'Always', animateMark: false }))
    sessionStorage.setItem('e2e-seeded', '1')
  })
  await page.goto('/?demo' + hash)
}

const out = process.env.VERIFY_DIR ?? 'e2e-artifacts'
const keep = async (page: Page, name: string, fullPage = false) => { await page.waitForTimeout(400); await page.screenshot({ path: `${out}/${name}.png`, fullPage }) }
const picker = (page: Page, label: string) => page.getByRole('button', { name: `Model: ${label}` })
const effort = (page: Page, mode: string, value: string) => page.getByRole('combobox', { name: `How hard ${mode} thinks: ${value}` })
const modeSwitch = (page: Page, mode: string) => page.getByRole('switch', { name: `${mode}: the team can use this mode` })
const box = async (loc: ReturnType<Page['locator']>) => { const b = await loc.boundingBox(); expect(b).not.toBeNull(); return b! }

test('Models: Max, Smart, Fast and Instant with Smart default and no add-on; switching one off hides it; effort persists and Reset demo clears it', async ({ page }) => {
  await start(page)
  await picker(page, 'Smart').click()
  const items = page.getByRole('menuitemradio')
  await expect(items).toHaveCount(4)
  await expect(items.nth(0)).toContainText('Max')
  await expect(items.nth(0)).toContainText('Fable 5.2 · Hardest problems and long jobs · costs most')
  await expect(items.nth(1)).toContainText('Smart')
  await expect(items.nth(1)).toContainText('Opus 5.5 · Best for most work')
  await expect(items.nth(2)).toContainText('Fast')
  await expect(items.nth(2)).toContainText('Sonnet 5.5 · Quick answers, still thinks well · half the cost')
  await expect(items.nth(3)).toContainText('Instant')
  await expect(items.nth(3)).toContainText('Haiku 5.5 · Simple lookups and sorting · costs least')
  await expect(items.nth(1)).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByText('Add-on')).toHaveCount(0)
  await expect(page.getByText('Second opinion')).toHaveCount(0)
  await expect(page.getByText('Admins choose which models the team can use, in Settings.')).toBeVisible()
  await keep(page, '1440-mode-picker')
  await page.keyboard.press('Escape')

  // The page: four rows in order, defaults, and the default mode can't be switched off.
  await page.goto('/?demo#/settings/team-modes')
  await expect(page.getByRole('heading', { name: 'Models', level: 1 })).toBeVisible()
  await expect(effort(page, 'Max', 'High')).toBeVisible()
  await expect(effort(page, 'Smart', 'Medium')).toBeVisible()
  await expect(effort(page, 'Fast', 'Medium')).toBeVisible()
  await expect(effort(page, 'Instant', 'Low')).toBeVisible()
  for (const m of ['Max', 'Smart', 'Fast', 'Instant']) await expect(modeSwitch(page, m)).toHaveAttribute('aria-checked', 'true')
  await expect(modeSwitch(page, 'Smart')).toBeDisabled()
  // The reason a locked switch can't be turned off is its description (and its tooltip), not a native title.
  await expect(modeSwitch(page, 'Smart')).toHaveAccessibleDescription('This is the default model')
  await expect(page.getByRole('combobox', { name: 'Default model: Smart' })).toBeVisible()
  await keep(page, '1440-thinking-modes-page')

  // Switch Instant off: it leaves the picker and the default list.
  await modeSwitch(page, 'Instant').click()
  await expect(modeSwitch(page, 'Instant')).toHaveAttribute('aria-checked', 'false')
  await page.getByRole('combobox', { name: 'Default model: Smart' }).click()
  await expect(page.getByRole('option')).toHaveCount(3)
  await expect(page.getByRole('option', { name: 'Instant' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  // Another default moves the locked switch to it.
  await page.getByRole('combobox', { name: 'Default model: Smart' }).click()
  await page.getByRole('option', { name: 'Fast' }).click()
  await expect(modeSwitch(page, 'Fast')).toBeDisabled()
  await expect(modeSwitch(page, 'Smart')).toBeEnabled()
  await page.goto('/?demo#/today')
  await expect(picker(page, 'Fast')).toBeVisible()
  await picker(page, 'Fast').click()
  await expect(page.getByRole('menuitemradio')).toHaveCount(3)
  await expect(page.getByRole('menuitemradio', { name: /Instant/ })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // Effort persists across a reload.
  await page.goto('/?demo#/settings/team-modes')
  await effort(page, 'Max', 'High').click()
  await expect(page.getByRole('option')).toHaveCount(5)
  for (const o of ['Low', 'Medium', 'High', 'Extra high', 'Highest']) await expect(page.getByRole('option', { name: o, exact: true })).toBeVisible()
  await page.getByRole('option', { name: 'Highest' }).click()
  await expect(effort(page, 'Max', 'Highest')).toBeVisible()
  await page.reload()
  await expect(effort(page, 'Max', 'Highest')).toBeVisible()
  await expect(modeSwitch(page, 'Instant')).toHaveAttribute('aria-checked', 'false')

  // Reset demo clears all of it.
  await page.getByRole('button', { name: /Demo switches/ }).click()
  await page.getByRole('button', { name: 'Reset demo', exact: true }).click()
  await expect(picker(page, 'Smart')).toBeVisible()
  await page.goto('/?demo#/settings/team-modes')
  await expect(effort(page, 'Max', 'High')).toBeVisible()
  await expect(modeSwitch(page, 'Instant')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('combobox', { name: 'Default model: Smart' })).toBeVisible()
})

test('Settings search finds Models by its name, effort, How hard it thinks and each mode label', async ({ page }) => {
  await start(page, '#/settings/you-general')
  const search = page.getByRole('searchbox', { name: 'Search settings' })
  const menu = page.getByRole('navigation', { name: 'Settings' })
  for (const q of ['Models', 'effort', 'How hard it thinks', 'Max', 'Smart', 'Fast', 'Instant']) {
    await search.fill(q)
    await expect(menu.getByRole('button', { name: /Models/ }), q).toBeVisible()
  }
  await search.fill('Default model')
  await expect(menu.getByRole('button', { name: /Models/ })).toBeVisible()
  await expect(menu.getByRole('button', { name: /^General/ })).toHaveCount(0)
})

test('Scrolling at 1440: the settings menu, the Library places panel and the sidebar stay put while only the content scrolls', async ({ page }) => {
  // Settings: a long page, scrolled to the bottom.
  await start(page, '#/settings/team-data')
  const nav = page.getByRole('navigation', { name: 'Settings' })
  const first = nav.getByRole('button', { name: 'General' })
  const content = nav.locator('xpath=following-sibling::div[1]')
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' })
  const [firstBefore, sideBefore] = [await box(first), await box(sidebar)]
  expect(await content.evaluate(el => el.scrollHeight > el.clientHeight + 200)).toBe(true)
  await content.evaluate(el => { el.scrollTop = el.scrollHeight })
  await expect.poll(() => content.evaluate(el => el.scrollTop)).toBeGreaterThan(200)
  expect(await box(first)).toEqual(firstBefore)
  expect(await box(sidebar)).toEqual(sideBefore)
  expect(await page.locator('main').evaluate(el => el.scrollTop)).toBe(0)
  expect(await page.evaluate(() => document.documentElement.scrollTop)).toBe(0)
  await expect(first).toBeInViewport()
  await expect(page.getByRole('button', { name: 'Ask the team' })).toBeInViewport()
  await keep(page, '1440-settings-scrolled')

  // Each settings page keeps its own scroll position.
  await nav.getByRole('button', { name: 'Audit log' }).click()
  await expect.poll(() => content.evaluate(el => el.scrollTop)).toBe(0)
  await nav.getByRole('button', { name: 'Data and access' }).click()
  await expect.poll(() => content.evaluate(el => el.scrollTop)).toBeGreaterThan(200)

  // Library: the places panel and the title row stay, the files scroll.
  await page.goto('/?demo#/library')
  const places = page.getByRole('complementary', { name: 'Places' })
  const all = places.getByRole('button', { name: /All files/ })
  const title = page.getByRole('heading', { level: 1, name: 'All files' })
  const files = page.getByRole('list', { name: 'Files' }).locator('xpath=..')
  const [allBefore, titleBefore] = [await box(all), await box(title)]
  expect(await files.evaluate(el => el.scrollHeight > el.clientHeight + 200)).toBe(true)
  await files.evaluate(el => { el.scrollTop = el.scrollHeight })
  await expect.poll(() => files.evaluate(el => el.scrollTop)).toBeGreaterThan(200)
  expect(await box(all)).toEqual(allBefore)
  expect(await box(title)).toEqual(titleBefore)
  expect(await box(sidebar)).toEqual(sideBefore)
  expect(await page.locator('main').evaluate(el => el.scrollTop)).toBe(0)
  await expect(all).toBeInViewport()
  await keep(page, '1440-library-scrolled')
})

// Every other page: the sidebar stays where it is while main scrolls.
for (const [name, hash] of [['today', '#/today'], ['approvals', '#/approvals'], ['routines', '#/routines'], ['activity', '#/activity'], ['tools', '#/tools'], ['tool-shopify', '#/tools/shopify'], ['skills', '#/skills'], ['usage', '#/usage'], ['chat', '#/chats/refunds'], ['chats-all', '#/chats/all']] as const) {
  test(`Scrolling at 1440: the sidebar stays put on ${name}`, async ({ page }) => {
    await start(page, hash)
    await page.waitForTimeout(500)
    const sidebar = page.getByRole('complementary', { name: 'Sidebar' })
    const before = await box(sidebar)
    await page.locator('main').evaluate(el => { el.scrollTop = el.scrollHeight })
    await page.evaluate(() => document.querySelectorAll('main *').forEach(el => { if (el.scrollHeight > el.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(el).overflowY)) el.scrollTop = el.scrollHeight }))
    expect(await box(sidebar)).toEqual(before)
    expect(await page.evaluate(() => document.documentElement.scrollTop)).toBe(0)
    await keep(page, `1440-${name}-scrolled`)
  })
}
