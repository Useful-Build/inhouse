// At 390: Settings, the Models page and the picker fit, nothing is cut off and the page scrolls naturally.
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

async function start(page: Page, hash: string) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-seeded')) return
    localStorage.clear()
    localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: 'Act', scenario: 'Normal', ambient: 'Always', animateMark: false }))
    sessionStorage.setItem('e2e-seeded', '1')
  })
  await page.goto('/?demo' + hash)
  await page.waitForTimeout(500)
}
const out = process.env.VERIFY_DIR ?? 'e2e-artifacts'
const keep = async (page: Page, name: string) => { await page.waitForTimeout(400); await page.screenshot({ path: `${out}/${name}.png` }) }
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

test('Phone: the Models page fits and scrolls with the page', async ({ page }) => {
  await start(page, '#/settings/team-modes')
  expect(await noSideways(page)).toBe(true)
  await expect(page.getByRole('switch', { name: 'Instant: the team can use this mode' })).toBeVisible()
  const main = page.locator('main')
  // Settings opens on the page alone now (menu first on a phone), so the last row starts in view: scroll the page itself.
  await page.getByRole('combobox', { name: 'Default model: Smart' }).hover()
  await page.mouse.wheel(0, 400)
  await expect.poll(() => main.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
  await keep(page, '390-thinking-modes-page')
})

test('Phone: Settings and the Library scroll naturally, with no nested scroll areas', async ({ page }) => {
  for (const [name, hash] of [['settings', '#/settings/team-data'], ['library', '#/library']] as const) {
    await start(page, hash)
    const nested = await page.evaluate(() => [...document.querySelectorAll('main *')].filter(el => {
      const o = getComputedStyle(el).overflowY
      return (o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight + 4
    }).length)
    expect(nested, name).toBe(0)
    expect(await noSideways(page)).toBe(true)
    await page.locator('main').evaluate(el => { el.scrollTop = el.scrollHeight })
    await keep(page, `390-${name}-scrolled`)
  }
})

for (const [name, hash] of [['today', '#/today'], ['approvals', '#/approvals'], ['routines', '#/routines'], ['activity', '#/activity'], ['tools', '#/tools'], ['skills', '#/skills'], ['usage', '#/usage'], ['chat', '#/chats/refunds'], ['chats-all', '#/chats/all']] as const) {
  test(`Phone: ${name} fits and scrolls`, async ({ page }) => {
    await start(page, hash)
    expect(await noSideways(page)).toBe(true)
    await page.locator('main').evaluate(el => { el.scrollTop = el.scrollHeight })
    await keep(page, `390-${name}-scrolled`)
  })
}
