// Every dropdown and menu list fits its content: no sideways scroll, and every check mark sits inside the list's box.
// Runs at 1440 and 390. Screenshots go to VERIFY_DIR (or e2e-artifacts/).
import { expect, fxFor, test } from './support/fx.js'
import type { Locator, Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { atRest } from './states.js'

const OUT = process.env.VERIFY_DIR ?? 'e2e-artifacts'
// The demo has no Notifications, Stage and plan, Who approves what or Run limits page since decision A13 (option B).
const TITLES: Record<string, string> = { 'you-general': 'General', 'you-memory': 'Memory', 'you-permissions': 'Always allowed', 'team-agent': 'Inhouse agent', 'team-memory': 'Team memory', 'team-members': 'Members', 'team-spend': 'Spending cap', 'team-data': 'Data and access', 'team-audit': 'Audit log' }
const PAGES = ['you-general', 'you-memory', 'you-permissions', 'team-agent', 'team-memory', 'team-members', 'team-spend', 'team-data', 'team-audit']

async function start(page: Page, hash: string) {
  await fxFor(page, undefined).seed({ demo: { ambient: 'Always' } })
  await page.goto('/?demo' + hash)
}

/** The list does not scroll sideways, stays inside the window, and every check mark is inside its box. */
async function fits(list: Locator, what: string) {
  const r = await list.evaluate(el => {
    const b = el.getBoundingClientRect()
    const marks = [...el.querySelectorAll('.ms')].filter(m => m.textContent === 'check')
      // A long menu scrolls: bring each mark into view first, so only a mark that overflows its row counts.
      .map(m => { m.scrollIntoView({ block: 'nearest', inline: 'nearest' }); return m.getBoundingClientRect() }).filter(r => r.width > 0)
    return {
      over: el.scrollWidth - el.clientWidth, left: b.left, right: b.right, vw: document.documentElement.clientWidth,
      marksOut: marks.filter(m => m.left < b.left || m.right > b.right || m.top < b.top || m.bottom > b.bottom).length,
      // A dropdown scrolls inside its viewport; a menu scrolls itself.
      scrolls: (s => s.scrollHeight > s.clientHeight)(el.querySelector('[data-radix-select-viewport]') ?? el),
      wide: [...el.querySelectorAll('*')].filter(c => c.getBoundingClientRect().right > b.right + 0.5).slice(0, 3).map(c => `${c.tagName}.${c.className} ${Math.round(c.getBoundingClientRect().right - b.right)}px`),
    }
  })
  expect(r.over, `${what}: scrollWidth - clientWidth, wide children: ${r.wide.join(', ')}`).toBeLessThanOrEqual(0)
  expect(r.marksOut, `${what}: check marks outside the list`).toBe(0)
  expect(r.left, `${what}: left edge`).toBeGreaterThanOrEqual(0)
  expect(r.right, `${what}: right edge`).toBeLessThanOrEqual(r.vw)
  return r
}

async function openSettingsMenu(page: Page, phone: boolean) {
  const side = page.getByRole('complementary', { name: 'Sidebar' })
  if (phone) await page.getByRole('button', { name: 'Menu' }).click()
  await side.getByRole('button', { name: /account and settings/i }).click()
}

// Headless Chromium hides scrollbars by default. Show them, like a Mac with a mouse, or a scrollbar bug can't appear.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--disable-features=OverlayScrollbar,FluentOverlayScrollbar'] } })

for (const width of [1440, 390]) {
  const phone = width < 600
  test.describe(`${width}px`, () => {
    test.use({ viewport: { width, height: phone ? 844 : 900 } })
    // Phones have overlay scrollbars (no width), so hide them here.
    if (phone) test.beforeEach(({ page }) => page.addInitScript(() => addEventListener('DOMContentLoaded', () => {
      const st = document.createElement('style'); st.textContent = '*::-webkit-scrollbar { display: none }'; document.head.append(st)
    })))
    const shot = async (page: Page, name: string) => { mkdirSync(OUT, { recursive: true }); await atRest(page); await page.screenshot({ path: `${OUT}/${name}-${width}.png` }) }

    test('Settings: every dropdown list fits, across all pages', async ({ page }) => {
      test.setTimeout(180_000)
      await start(page, '#/settings/you-general')
      let opened = 0, widest = 0, widestPage = '', widestIdx = 0
      for (const id of PAGES) {
        await page.evaluate(h => { location.hash = h }, `#/settings/${id}`)
        await expect(page.getByRole('heading', { level: 1, name: TITLES[id] })).toBeVisible() // this page drew, so its dropdowns are counted
        await atRest(page)
        const buttons = page.locator('main [role="combobox"]')
        const n = await buttons.count()
        // Team settings are read-only text on a phone (D4): not one dropdown there.
        if (phone && id.startsWith('team-')) expect(n, `${id}: no dropdown on a phone`).toBe(0)
        for (let i = 0; i < n; i++) {
          const b = buttons.nth(i)
          if (await b.isDisabled()) continue
          await b.scrollIntoViewIfNeeded()
          await b.click()
          const list = page.getByRole('listbox')
          await expect(list).toHaveCount(1)
          const r = await fits(list, `${id} dropdown ${i} (${await b.getAttribute('aria-label')})`)
          opened++
          const w = await list.evaluate(el => el.getBoundingClientRect().width)
          if (w > widest) { widest = w; widestPage = id; widestIdx = i }
          await page.keyboard.press('Escape')
          await expect(list).toHaveCount(0)
          void r
        }
      }
      // On a phone only Your settings has dropdowns (Theme, Language, Text size, Time zone). 14 on desktop since the
      // Notifications, Who approves what and Run limits pages (8 of the 22 before) left with decision A13.
      expect(opened, 'dropdowns opened').toBeGreaterThan(phone ? 3 : 13)
      test.info().annotations.push({ type: 'dropdowns opened', description: String(opened) })
      test.info().annotations.push({ type: 'widest', description: `${widestPage} #${widestIdx} ${Math.round(widest)}px` })

      // Screenshots: a short one, the longest one with its scrollbar, and the widest.
      // The short list is on a team page, which has no dropdowns on a phone (D4): desktop only.
      if (!phone) {
        await page.evaluate(() => { location.hash = '#/settings/team-spend' })
        await page.getByRole('combobox', { name: /^Alert at/ }).click()
        await shot(page, 'dropdown-short')
        await page.keyboard.press('Escape')
      } else {
        await page.evaluate(() => { location.hash = '#/settings/team-spend' })
        await expect(page.getByRole('combobox')).toHaveCount(0)
        await expect(page.getByText('Alert at', { exact: true })).toBeVisible()
      }
      await page.evaluate(() => { location.hash = '#/settings/you-general' })
      await page.getByRole('combobox', { name: /^Time zone/ }).click()
      const tz = await fits(page.getByRole('listbox'), 'time zone')
      expect(tz.scrolls, 'time zone list scrolls vertically').toBe(true)
      await shot(page, 'dropdown-longest')
      await page.keyboard.press('Escape')
      await page.evaluate(h => { location.hash = h }, `#/settings/${widestPage}`)
      await page.locator('main [role="combobox"]:not([disabled])').nth(widestIdx).click()
      await shot(page, 'dropdown-widest')
    })

    test('Today picker, account menu, composer menus and message menu fit', async ({ page }) => {
      test.setTimeout(120_000)
      await start(page, '#/today')
      // A phone has no sort on Today (one list, most urgent first): the picker is checked at desktop width.
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      if (phone) {
        await expect(page.getByRole('combobox', { name: /^Sort cards/ })).toHaveCount(0)
      } else {
        await page.getByRole('combobox', { name: /^Sort cards/ }).click()
        await fits(page.getByRole('listbox', { name: 'Sort cards' }), 'Today sort')
        await page.keyboard.press('Escape')
      }

      // On a phone the composer is slim: Tools read and Model live inside "+" (Attach), so only that one opens.
      const composerMenus = phone ? [['Attach', 'attach']] as const : [['Attach', 'attach'], ['Tools read', 'tools'], ['Model', 'model']] as const
      for (const [label, name] of composerMenus) {
        await page.getByRole('button', { name: new RegExp(`^${label}`) }).click()
        const menu = page.getByRole('menu')
        await expect(menu).toHaveCount(1)
        await fits(menu, `composer ${name} menu`)
        if (name === 'model') await shot(page, 'model-menu')
        await page.keyboard.press('Escape')
        await page.mouse.click(5, 5)
        await expect(menu).toHaveCount(0)
      }

      await openSettingsMenu(page, phone)
      const account = page.getByRole('menu', { name: 'Account' })
      await expect(account).toBeVisible()
      await fits(account.locator('..'), 'account menu')
      await shot(page, 'account-menu')
      await page.keyboard.press('Escape')
      await page.mouse.click(width - 5, 5)

      await page.evaluate(() => { location.hash = '#/chats/refunds' })
      await page.getByRole('button', { name: 'More' }).first().click({ force: true })
      await fits(page.getByRole('menu', { name: 'Message actions' }), 'message actions menu')
    })
  })
}

// A short window: the lowest dropdown on each Settings page, scrolled to the bottom, opens where it stays fully visible
// (inside the window and inside the page's own scroll area), upward when there is no room below.
test.describe('1440x700', () => {
  test.use({ viewport: { width: 1440, height: 700 } })
  test('Settings: the lowest dropdown on every page stays fully visible', async ({ page }) => {
    test.setTimeout(120_000)
    await start(page, '#/settings/you-general')
    let upward = 0
    for (const id of PAGES) {
      await page.evaluate(h => { location.hash = h }, `#/settings/${id}`)
      await expect(page.getByRole('heading', { level: 1, name: TITLES[id] })).toBeVisible() // this page drew, so its dropdowns are counted
      await atRest(page)
      const buttons = page.locator('main [role="combobox"]:not([disabled])')
      const n = await buttons.count()
      if (n === 0) continue
      const b = buttons.nth(n - 1)
      // Scroll the page's own area to the very bottom, so the lowest dropdown is as low as it gets.
      await b.evaluate(el => { for (let p = el.parentElement; p; p = p.parentElement) if (['auto', 'scroll'].includes(getComputedStyle(p).overflowY)) { p.scrollTop = p.scrollHeight; break } })
      await b.click()
      const list = page.getByRole('listbox')
      await expect(list).toHaveCount(1)
      const r = await list.evaluate((el, btn) => {
        const l = el.getBoundingClientRect(), bb = (btn as HTMLElement).getBoundingClientRect()
        let area = { top: 0, bottom: window.innerHeight }
        for (let p = (btn as HTMLElement).parentElement; p; p = p.parentElement) if (['auto', 'scroll'].includes(getComputedStyle(p).overflowY)) { const a = p.getBoundingClientRect(); area = { top: Math.max(0, a.top), bottom: Math.min(window.innerHeight, a.bottom) }; break }
        const sc = el.querySelector('[data-radix-select-viewport]') ?? el
        return { top: l.top, bottom: l.bottom, up: l.bottom <= bb.top + 1, area, height: l.height, scrolls: sc.scrollHeight > sc.clientHeight }
      }, await b.elementHandle())
      expect(r.top, `${id}: list top inside its area`).toBeGreaterThanOrEqual(r.area.top - 1)
      expect(r.bottom, `${id}: list bottom inside its area`).toBeLessThanOrEqual(r.area.bottom + 1)
      if (r.up) upward++
      if (id === 'you-general') await shot700(page, 'settings-lowest-dropdown-1440x700')
      await page.keyboard.press('Escape')
      await expect(list).toHaveCount(0)
    }
    expect(upward, 'at least one lowest dropdown opened upward').toBeGreaterThan(0)
  })
})
const shot700 = async (page: Page, name: string) => { mkdirSync(OUT, { recursive: true }); await atRest(page); await page.screenshot({ path: `${OUT}/${name}.png` }) }
