// At 390: Settings, the Models page and the picker fit, nothing is cut off and the page scrolls naturally.
import { expect, fxFor, test } from './support/fx.js'
import type { Page } from '@playwright/test'
import { atRest } from './states.js'

/** Opens a page and waits for it to draw. Seeds nothing: seed a page once (`start`), then use this to move around. */
async function visit(page: Page, hash: string) {
  await page.goto('/?demo' + hash)
  await expect(page.locator('main')).toBeVisible() // the page drew (a chat has no h1)
  await atRest(page)
}
async function start(page: Page, hash: string) {
  await fxFor(page, undefined).seed({ stage: 'Act', demo: { ambient: 'Always' } })
  await visit(page, hash)
}
const out = process.env.VERIFY_DIR ?? 'e2e-artifacts'
const keep = async (page: Page, name: string) => { await atRest(page); await page.screenshot({ path: `${out}/${name}.png` }) }
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('main')].every(m => m.scrollWidth <= m.clientWidth))

test('Phone: the mode picker fits', async ({ page }) => {
  await start(page, '#/today')
  // A phone keeps the model in "+" (M27).
  await page.locator('[data-composer]').getByRole('button', { name: 'Attach' }).click()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('group', { name: 'Model' }).getByRole('menuitemradio')).toHaveCount(4)
  const b = (await menu.boundingBox())!
  expect(b.x).toBeGreaterThanOrEqual(0)
  expect(b.x + b.width).toBeLessThanOrEqual(390)
  await keep(page, '390-mode-picker')
})

test('Phone: the Models page fits and reads as text', async ({ page }) => {
  await start(page, '#/settings/team-modes')
  await expect.poll(() => noSideways(page)).toBe(true)
  // Team settings are read on a phone (D4): the values show as text, with no control to change them.
  await expect(page.getByRole('note')).toContainText('Change these on a computer.')
  await expect(page.getByRole('switch')).toHaveCount(0)
  await expect(page.getByRole('combobox')).toHaveCount(0)
  await expect(page.locator('main')).toContainText('Instant')
  await expect(page.locator('main')).toContainText('Low · team can use it')
  // One "How hard it thinks" caption over the rows, not "Effort:" on each.
  await expect(page.locator('main').getByText('How hard it thinks', { exact: true })).toHaveCount(1)
  // The last row, the default model, is on the page, and the page's own main is the scroll area.
  await expect(page.locator('main').getByText('Default model', { exact: true })).toBeVisible()
  expect(await page.locator('main').evaluate(el => ['auto', 'scroll'].includes(getComputedStyle(el).overflowY))).toBe(true)
  await expect.poll(() => noSideways(page)).toBe(true)
  await keep(page, '390-thinking-modes-page')
})

test('Phone: a model turned off on a computer reads "<Effort> · turned off" on its own line', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await start(page, '#/settings/team-modes')
  const sw = page.getByRole('switch', { name: 'Instant: the team can use this model' })
  await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', 'false')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('switch')).toHaveCount(0)
  await expect(page.locator('main')).toContainText('Low · turned off')
  await expect.poll(() => noSideways(page)).toBe(true)
})

test('Phone: a long settings page scrolls with the page (main moves, nothing nested)', async ({ page }) => {
  await start(page, '#/settings/team-data')
  // Settings loads on first visit (its own chunk): measure once the page is in.
  await expect(page.getByRole('heading', { level: 1, name: 'Data and access' })).toBeVisible()
  const main = page.locator('main')
  expect(await main.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
  expect(await main.evaluate(el => el.scrollTop)).toBe(0)
  await page.mouse.move(195, 400)
  await page.mouse.wheel(0, 600)
  await expect.poll(() => main.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
})

test('Phone: Settings and the Library scroll naturally, with no nested scroll areas', async ({ page }) => {
  await start(page, '#/settings/team-data')
  for (const [name, hash] of [['settings', '#/settings/team-data'], ['library', '#/library']] as const) {
    await visit(page, hash)
    const nested = await page.evaluate(() => [...document.querySelectorAll('main *')].filter(el => {
      const o = getComputedStyle(el).overflowY
      return (o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight + 4
    }).length)
    expect(nested, name).toBe(0)
    await expect.poll(() => noSideways(page)).toBe(true)
    await page.locator('main').evaluate(el => { el.scrollTop = el.scrollHeight })
    await keep(page, `390-${name}-scrolled`)
  }
})

for (const [name, hash] of [['today', '#/today'], ['approvals', '#/approvals'], ['routines', '#/routines'], ['activity', '#/activity'], ['tools', '#/tools'], ['skills', '#/skills'], ['usage', '#/usage'], ['chat', '#/chats/refunds'], ['chats-all', '#/chats/all']] as const) {
  test(`Phone: ${name} fits and scrolls`, async ({ page }) => {
    await start(page, hash)
    await expect.poll(() => noSideways(page)).toBe(true)
    await page.locator('main').evaluate(el => { el.scrollTop = el.scrollHeight })
    await keep(page, `390-${name}-scrolled`)
  })
}
