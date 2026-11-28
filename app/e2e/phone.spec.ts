// Phone (390 px): Today, the problem panel, Approvals and Chats must work with no sideways scroll.
import { expect, test, type Fx } from './support/fx.js'
import type { Page } from '@playwright/test'
import { atRest } from './states.js'

const seeded = new WeakSet<Page>()
async function start(page: Page, fx: Fx, hash: string) {
  // A test opens several pages; one seed covers them all (a page takes one seed).
  if (!seeded.has(page)) {
    seeded.add(page)
    await fx.seed({ demo: { ambient: 'Always', animateMark: true } })
  }
  await page.goto('/?demo' + hash)
}

async function noSidewaysScroll(page: Page) {
  // Polled: right after a resize or a navigation the layout may not have settled yet. A real overflow still fails.
  await expect.poll(() => page.evaluate(() => Math.max(...[document.documentElement, document.querySelector('main')!].map(e => e.scrollWidth - e.clientWidth))),
    { message: 'horizontal overflow in px (page or main)' }).toBeLessThanOrEqual(1)
}

test('Phone: Today, panel, Approvals and Chats fit 390 px; the drawer closes on navigation', async ({ fx, page }) => {
  await start(page, fx, '#/today')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('3 left to approve today.')
  await noSidewaysScroll(page)
  await page.screenshot({ path: test.info().outputPath('phone-today.png'), fullPage: true })

  // A finding's window (#726: the Kestrel reorder is a suggestion now, with no draft).
  await page.getByRole('article', { name: 'Ridge 30L Pack runs out in 9 days' }).getByRole('button', { name: 'Ridge 30L Pack runs out in 9 days', exact: true }).click()
  const panel = page.getByRole('dialog')
  await expect(panel).toContainText('Your Inhouse agent suggests')
  const box = await panel.boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  await page.screenshot({ path: test.info().outputPath('phone-panel.png') })
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Menu' }).click()
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Approvals/ }).click()
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0)
  await expect(page.getByText(/Waiting for you/)).toBeVisible()
  await noSidewaysScroll(page)
  await page.screenshot({ path: test.info().outputPath('phone-approvals.png'), fullPage: true })

  await page.getByRole('button', { name: 'Menu' }).click()
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Stuck orders over 3 days' }).click()
  await expect(page.getByText('3 orders · $556')).toBeVisible()
  await noSidewaysScroll(page)
  await page.screenshot({ path: test.info().outputPath('phone-chats.png') })
})

test('Phone: the account menu and the team window open above the drawer', async ({ fx, page }) => {
  await start(page, fx, '#/today')
  const side = page.getByRole('complementary', { name: 'Sidebar' })

  await page.getByRole('button', { name: 'Menu' }).click()
  await side.getByRole('button', { name: /account and settings/i }).click()
  await page.getByRole('menu', { name: 'Account' }).getByRole('menuitem', { name: /^Your Inhouse team/ }).click()
  const team = page.getByRole('dialog', { name: 'Your Inhouse team' })
  await expect(team).toBeVisible()
  await expect(side).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath('phone-team-window.png') })
  await team.getByRole('button', { name: 'Close' }).first().click()

  await page.getByRole('button', { name: 'Menu' }).click()
  await side.getByRole('button', { name: /account and settings/i }).click()
  const menu = page.getByRole('menu', { name: 'Account' })
  await expect(menu).toBeVisible()
  // The menu opens from its trigger inside the drawer, so the drawer stays until an item is picked.
  await expect(side).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('phone-account-menu.png') })
  await menu.getByRole('menuitem', { name: 'Your settings' }).click()
  // On a phone the settings menu shows first, then the page picked from it.
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  await expect(side).toHaveCount(0)
  await page.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'General' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'General' })).toBeVisible()
})

test('Phone: the drawer has no Chats item; See all, a recent chat and a Settings dropdown fit 390 px', async ({ fx, page }) => {
  await start(page, fx, '#/today')
  const side = page.getByRole('complementary', { name: 'Sidebar' })
  await page.getByRole('button', { name: 'Menu' }).click()
  await expect(side.getByRole('button', { name: 'Chats', exact: true })).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath('phone-drawer.png') })
  await side.getByRole('button', { name: 'See all' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'All chats' })).toBeVisible()
  await page.getByRole('searchbox', { name: 'Search chats' }).fill('ridge')
  await noSidewaysScroll(page)
  await page.screenshot({ path: test.info().outputPath('phone-chats-list.png'), fullPage: true })
  await page.getByRole('button', { name: /Ridge 30L reorder quantity/ }).click()
  await expect(page.getByText('You sell about 21 a day and have 295 left')).toBeVisible()
  await noSidewaysScroll(page)
  await page.screenshot({ path: test.info().outputPath('phone-chat-ridge.png') })

  await page.evaluate(() => { location.hash = '#/settings/you-general' })
  await page.getByRole('combobox', { name: 'Time zone: Eastern Time (New York)' }).click()
  const list = page.getByRole('listbox', { name: 'Time zone' })
  const box = await list.boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  await page.screenshot({ path: test.info().outputPath('phone-settings-dropdown.png') })
  await list.getByRole('option', { name: 'Central European Time (Paris)' }).click()
  await expect(page.getByRole('combobox', { name: 'Time zone: Central European Time (Paris)' })).toBeVisible()
  // Search lives on the settings menu, a step back from the page.
  await page.getByRole('button', { name: 'Back to settings' }).click()
  await page.getByRole('searchbox', { name: 'Search settings' }).fill('language')
  await noSidewaysScroll(page)
  await page.screenshot({ path: test.info().outputPath('phone-settings-search.png'), fullPage: true })
})

test('Phone: Library shows places as chips, one list, a filter sheet, and a viewer that fits 390 px', async ({ fx, page }) => {
  await start(page, fx, '#/library')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('All files')
  await noSidewaysScroll(page)
  // Places are a chip row at the top, with the search box above it.
  const nav = page.getByRole('navigation', { name: 'Library places' })
  await expect(page.getByRole('searchbox', { name: 'Search library' })).toBeVisible()
  await expect(nav.getByRole('button', { name: /^All files \d+$/ })).toHaveAttribute('aria-pressed', 'true')
  const chips = await nav.evaluate(e => ({ sw: e.scrollWidth, cw: e.clientWidth }))
  expect(chips.sw, 'the chip row scrolls sideways inside itself').toBeGreaterThan(chips.cw)
  // Sort, type and view are not on the page: one list, and a Filters button for the rest.
  await expect(page.getByRole('radiogroup', { name: 'File type' })).toHaveCount(0)
  await expect(page.getByRole('radiogroup', { name: 'View' })).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: /^Sort/ })).toHaveCount(0)
  // One column of rows, each with a type badge and no picture.
  const rows = page.getByRole('list', { name: 'Files' }).getByRole('listitem')
  const xs = await rows.evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().left)))
  expect(new Set(xs).size, `columns at ${[...new Set(xs)]}`).toBe(1)
  await expect(rows.locator('img')).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath('phone-library-list.png') })
  // A place from the chips.
  await nav.getByRole('button', { name: /^Approvals/ }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Approvals')
  await noSidewaysScroll(page)
  await nav.getByRole('button', { name: /^All files/ }).click()
  // Select fits.
  await page.getByRole('button', { name: 'Select', exact: true }).click()
  await rows.nth(0).click()
  await rows.nth(1).click()
  const bar = page.getByRole('toolbar', { name: 'Selected files' })
  await expect(bar).toContainText('2 selected')
  const b = await bar.boundingBox()
  expect(b!.x).toBeGreaterThanOrEqual(0)
  expect(b!.x + b!.width).toBeLessThanOrEqual(390)
  await page.screenshot({ path: test.info().outputPath('phone-library-select.png') })
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  // The viewer.
  await rows.filter({ hasText: 'amazon-fee-reimbursement' }).click()
  const v = page.getByRole('dialog', { name: /^File: amazon-fee-reimbursement/ })
  await expect(v).toBeVisible()
  const box = await v.boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  await expect(v.getByRole('button', { name: 'Download' })).toBeAttached()
  await page.screenshot({ path: test.info().outputPath('phone-library-viewer.png') })
})

// ---------- more phone checks ----------

const outDir = process.env.VERIFY_DIR ?? 'e2e-artifacts'
const keep = async (page: Page, name: string, fullPage = false) => { await atRest(page); await page.screenshot({ path: `${outDir}/${name}.png`, fullPage }) }

/** No button, link or field overlaps the demo switcher's circle. */
async function nothingUnderSwitcher(page: Page) {
  const hits = await page.evaluate(() => {
    const sw = document.querySelector<HTMLElement>('button[aria-label^="Demo switches"]')
    if (!sw) return ['the switcher is missing']
    const r = sw.getBoundingClientRect()
    const found: string[] = []
    for (const el of document.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, [role="button"]')) {
      if (el === sw || sw.contains(el)) continue
      const b = el.getBoundingClientRect()
      if (!b.width || !b.height) continue
      if (b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top) found.push((el.getAttribute('aria-label') ?? el.textContent ?? el.tagName).trim().slice(0, 40))
    }
    return found
  })
  expect(hits, 'controls under the demo switcher').toEqual([])
}

test('Phone: with ?demo nothing sits under the switcher, and Library file names show whole', async ({ fx, page }) => {
  for (const hash of ['#/library', '#/settings/you-general', '#/today', '#/chats/refunds']) {
    await start(page, fx, hash)
    await expect(page.getByRole('button', { name: /^Demo switches/ })).toBeVisible()
    await nothingUnderSwitcher(page)
  }
  await start(page, fx, '#/library')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('All files')
  // 28 characters in a row: the whole name shows, on at most two lines.
  const fit = async (text: string) => {
    const name = page.getByRole('list', { name: 'Files' }).getByText(text, { exact: true })
    await name.scrollIntoViewIfNeeded()
    const m = await name.evaluate(e => ({ clipped: e.scrollHeight > e.clientHeight + 1, lines: Math.round(e.clientHeight / parseFloat(getComputedStyle(e).lineHeight)) }))
    expect(m.clipped, `${text} is cut off`).toBe(false)
    expect(m.lines).toBeLessThanOrEqual(2)
  }
  await fit('trail-shell-jacket-olive.png')
  await fit('stuck-orders-over-3-days.csv')
  await noSidewaysScroll(page)
  await page.evaluate(() => document.querySelector('main')!.scrollTo({ top: 0 }))
  await keep(page, 'library-390')
})

test('Phone: reopening the open chat from See all keeps what was added', async ({ fx, page }) => {
  await start(page, fx, '#/chats/refunds')
  await page.getByRole('textbox', { name: 'Message Inhouse' }).fill('And what about last week?')
  await page.locator('[data-composer]').getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('And what about last week?', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Menu' }).click()
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'See all' }).click()
  await page.getByRole('main').getByRole('button', { name: /Why did refunds jump/ }).click()
  await expect(page.getByText('And what about last week?', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Menu' }).click()
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Why did refunds jump?', exact: true }).click()
  await expect(page.getByText('And what about last week?', { exact: true })).toBeVisible()
  await noSidewaysScroll(page)
  await keep(page, 'chat-reopen-390')
})

test("Phone: Usage shows the capped state for a low saved cap, and there's no month picker", async ({ fx, page }) => {
  // Team settings are read on a phone, so the cap is set at a desktop width first.
  await page.setViewportSize({ width: 1440, height: 900 })
  await start(page, fx, '#/settings/team-spend')
  const cap = page.getByRole('textbox', { name: 'Monthly cap' })
  await cap.fill('$50')
  await cap.blur()
  await expect(page.locator('[data-toast]').filter({ hasText: 'Saved' })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => { location.hash = '#/usage' })
  await expect(page.getByText('$78.40 of $50', { exact: true })).toBeVisible()
  await expect(page.getByText('Cap reached with 14 days of the month left')).toBeVisible()
  // November is the first month with spend (the first tool was connected on Nov 2), the only one: no month picker.
  await expect(page.getByRole('combobox', { name: /^Month/ })).toHaveCount(0)
  await noSidewaysScroll(page)
  await keep(page, 'usage-390', true)
})
