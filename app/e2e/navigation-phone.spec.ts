// PR 5, navigation on a phone (390 px): the top bar names Today and chats, not a page with its own h1, the palette opens from its button and fits the
// screen, and the toast's Undo and a Switch take 44px taps.
import { expect, test } from './csp.js'
import type { Locator, Page } from '@playwright/test'

async function start(page: Page, hash: string) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-seeded')) return
    localStorage.clear()
    localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: 'Act', scenario: 'Normal', ambient: 'Always', animateMark: false }))
    sessionStorage.setItem('e2e-seeded', '1')
  })
  await page.goto('/?demo' + hash)
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
}

const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)))
const shot = async (page: Page, name: string) => { await settled(page); await page.screenshot({ path: test.info().outputPath(`${name}.png`) }) }
const header = (page: Page) => page.getByRole('banner')
const hash = (page: Page) => page.evaluate(() => location.hash)

/** The clickable box of a control: its own box joined with its ::after hit area (as in page-actions-phone.spec.ts). */
const hitBox = (el: Locator) => el.evaluate(e => {
  const r = e.getBoundingClientRect()
  const a = getComputedStyle(e, '::after')
  const w = parseFloat(a.width), h = parseFloat(a.height)
  if (a.position !== 'absolute' || !(w > 0) || !(h > 0)) return { w: r.width, h: r.height }
  const m = new DOMMatrixReadOnly(a.transform === 'none' ? undefined : a.transform)
  const left = parseFloat(a.left) + m.m41, top = parseFloat(a.top) + m.m42
  return { w: Math.max(r.width, left + w) - Math.min(0, left), h: Math.max(r.height, top + h) - Math.min(0, top) }
})
const atLeast44 = async (el: Locator) => {
  const b = await hitBox(el)
  expect(b.w, 'hit area width').toBeGreaterThanOrEqual(44)
  expect(b.h, 'hit area height').toBeGreaterThanOrEqual(44)
}

test("Phone: the top bar doesn't repeat a page's own h1, and names Today and an open chat", async ({ page }) => {
  const title = header(page).locator('[data-topbar-title]')
  await start(page, '#/library')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  let before = (await page.getByRole('heading', { level: 1 }).first().textContent()) ?? ''
  await expect(title).toHaveText('')
  for (const link of ['#/approvals', '#/activity', '#/tools', '#/tools/shopify', '#/skills', '#/usage', '#/settings/you-general', '#/chats/all']) {
    await page.evaluate(h => { location.hash = h }, link)
    await expect.poll(() => hash(page), link).toBe(link)
    const h1 = page.getByRole('heading', { level: 1 }).first()
    await expect(h1, link).toBeVisible()
    await expect(h1, link).not.toHaveText(before)
    before = (await h1.textContent()) ?? ''
    await expect(title, link).toHaveText('')
  }
  // Through the drawer too.
  const menu = page.getByRole('button', { name: 'Menu' })
  await expect(menu).not.toHaveAttribute('aria-controls', /.+/)
  await atLeast44(menu)
  await atLeast44(page.getByRole('button', { name: /^Notifications/ }))
  await menu.click()
  await expect(page.locator('button[aria-label="Menu"]')).toHaveAttribute('aria-controls', 'sidebar')
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Routines' }).click()
  await expect.poll(() => hash(page)).toBe('#/routines')
  await expect(page.getByRole('heading', { level: 1, name: 'Routines' })).toBeVisible()
  await expect(title).toHaveText('')
  await shot(page, 'phone-topbar-routines')
  await page.evaluate(() => { location.hash = '#/today' })
  await expect(title).toHaveText('Today')
})

test('Phone: the palette opens from its button, fits the screen and opens a page', async ({ page }) => {
  await start(page, '#/today')
  await page.getByRole('button', { name: 'Menu' }).click()
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Search' }).click()
  const palette = page.getByRole('dialog', { name: 'Search' })
  await expect(palette).toBeVisible()
  await expect(palette.getByRole('combobox')).toBeFocused()
  await settled(page)
  const b = (await palette.boundingBox())!
  expect(b.x).toBeGreaterThanOrEqual(0)
  expect(b.y).toBeGreaterThanOrEqual(0)
  expect(b.x + b.width).toBeLessThanOrEqual(390)
  expect(b.y + b.height).toBeLessThanOrEqual(844)
  expect(await palette.evaluate(e => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1)
  await shot(page, 'phone-palette')
  await palette.getByRole('combobox').fill('usage')
  await page.keyboard.press('Enter')
  await expect.poll(() => hash(page)).toBe('#/usage')
  await expect(page.getByRole('heading', { level: 1, name: 'Usage' })).toBeVisible()
})

test("Phone: the toast's Undo and a Switch take 44px taps", async ({ page }) => {
  await start(page, '#/today')
  await page.getByRole('article').first().getByRole('button', { name: 'More' }).click()
  await page.getByRole('menu', { name: 'Card actions' }).getByRole('menuitem', { name: 'Snooze until tomorrow' }).click()
  const undo = page.locator('[data-toast]').getByRole('button', { name: 'Undo', exact: true })
  await expect(undo).toBeVisible()
  await atLeast44(undo)
  await shot(page, 'phone-toast-undo')

  await page.evaluate(() => { location.hash = '#/settings/you-notif' })
  const sw = page.getByRole('switch').first()
  await expect(sw).toBeVisible()
  await atLeast44(sw)
  // The small switch in the demo panel too.
  await page.getByRole('button', { name: /Demo switches/ }).click()
  await atLeast44(page.getByRole('dialog', { name: 'Demo switches' }).getByRole('switch'))
})

test('Phone: Skip to content is the first Tab stop and moves focus into main', async ({ page }) => {
  await start(page, '#/activity')
  await page.keyboard.press('Tab')
  const skip = page.getByRole('link', { name: 'Skip to content' })
  await expect(skip).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('main')).toBeFocused()
  expect(await hash(page)).toBe('#/activity')
  await shot(page, 'phone-skip-link')
})

test('Phone: every Activity time sits on one line in its column', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-seeded')) return
    localStorage.clear()
    localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: 'Run', scenario: 'Normal', ambient: 'Always', animateMark: false }))
    sessionStorage.setItem('e2e-seeded', '1')
  })
  await page.goto('/?demo#/activity')
  // Run shows the most lines, "10:12 AM" the widest time.
  const times = page.locator('[data-activity-row] > span:first-child')
  await expect(times.first()).toBeVisible()
  await expect(page.locator('main')).toContainText('10:12 AM')
  const lines = await times.evaluateAll(els => els.map(e => ({ t: e.textContent, lines: Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)) })))
  expect(lines.filter(l => l.lines !== 1), 'times that wrap').toEqual([])
  await shot(page, 'phone-activity-times')
})
