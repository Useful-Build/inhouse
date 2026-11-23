// Every overlay by keyboard, in dark: the command palette, Help, the team window, the problem panel, the trace window,
// a Library file viewer, a confirm question, the notifications pop-up, the account menu and a Settings dropdown each
// open from a focused trigger and close with Escape, with focus back on that trigger. A window or sheet opens with focus
// on itself, never with a focus ring or a "Close" tooltip on its Close button (L6). A locked switch says why in a tooltip
// that keyboard focus reaches (M31). "Skip to content" is the first Tab stop and the top bar is the banner (L18). Each
// overlay's screenshot is attached to the test report.
import { expect, test, type Fx } from './support/fx.js'
import type { Locator, Page } from '@playwright/test'

const seeded = new WeakSet<Page>()
async function open(page: Page, fx: Fx, hash: string, ready: string) {
  await page.emulateMedia({ colorScheme: 'dark' })
  // A test opens several pages; one seed covers them all (a page takes one seed).
  if (!seeded.has(page)) {
    seeded.add(page)
    await fx.seed({ stage: 'Act', theme: 'dark', once: false })
  }
  await page.goto('/?demo' + hash)
  await expect(page.getByText(ready, { exact: false }).first()).toBeVisible()
  await expect(page.locator('html')).toHaveClass(/\bdark\b/)
}

// A toast that leaves mid-shot cancels its animation: cancelled counts as settled.
const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => undefined))))
/** The repeatable artifact: the open overlay, attached to the report under its name. */
async function attach(page: Page, name: string) {
  await settled(page)
  await test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' })
}
const side = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' })
const header = (page: Page) => page.getByRole('banner')
const account = (page: Page) => side(page).getByRole('button', { name: /account and settings/ })
/** The open tooltip with this text (one that is closing can still be in the page for a moment). */
const tip = (page: Page, text: string | RegExp) => page.getByRole('tooltip').filter({ hasText: text })

/** Focus a trigger and press a key on it, as a keyboard user would. */
async function press(trigger: Locator, key = 'Enter') {
  await trigger.focus()
  await expect(trigger).toBeFocused()
  await trigger.page().keyboard.press(key)
}

/** A window or sheet that just opened: focus is inside it, and its Close button has no focus (so no ring) and no tooltip. */
async function opensQuiet(page: Page, dialog: Locator) {
  await expect(dialog).toBeVisible()
  expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true)
  const close = dialog.getByRole('button', { name: 'Close', exact: true })
  await expect(close).toBeVisible()
  // Once the window has settled, a Close that took focus would show its tooltip (Radix opens one on keyboard focus with
  // no delay).
  await settled(page)
  await expect(close).not.toBeFocused()
  expect(await tip(page, /^Close$/).count()).toBe(0)
}

/** Escape closes the overlay and focus is back on what opened it. */
async function escapeTo(page: Page, overlay: Locator, trigger: Locator) {
  await page.keyboard.press('Escape')
  await expect(overlay).toHaveCount(0)
  await expect(trigger).toBeFocused()
}

test('Dark, by keyboard: the palette, Help, the team window, the account menu and notifications open and give focus back', async ({ fx, page }) => {
  await open(page, fx, '#/today', '6 things need you')

  // Command palette, from the sidebar's Search row: the field has focus, Escape gives it back.
  const search = side(page).getByRole('button', { name: 'Search', exact: true })
  await press(search)
  const palette = page.getByRole('dialog', { name: 'Search' })
  await expect(palette.getByRole('combobox')).toBeFocused()
  await attach(page, 'palette')
  await escapeTo(page, palette, search)

  // Account menu: Enter opens it on its first item, Escape closes it.
  await press(account(page))
  const menu = page.getByRole('menu', { name: 'Account' })
  await expect(menu.getByRole('menuitem', { name: 'Your settings' })).toBeFocused()
  await attach(page, 'account-menu')
  await escapeTo(page, menu, account(page))

  // Help, from the account menu with the arrow keys: it opens quiet, Tab reaches Close and then the first guide,
  // Enter opens that guide in the accordion, Escape closes Help and focus is back on the account button.
  // The menu moves focus a tick after each arrow key (Radix's roving focus defers it), so wait for each step to land:
  // two arrows sent back to back both reach the same item, and focus moves only once.
  await press(account(page))
  await expect(menu.getByRole('menuitem', { name: 'Your settings' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('menuitem', { name: 'Team settings' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('menuitem', { name: 'Usage' })).toBeFocused()
  // The separator is skipped.
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('menuitem', { name: /^Your Inhouse team/ })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('menuitem', { name: 'Help and guides' })).toBeFocused()
  await page.keyboard.press('Enter')
  const help = page.getByRole('dialog', { name: 'Help and guides' })
  await opensQuiet(page, help)
  await page.keyboard.press('Tab')
  await expect(help.getByRole('button', { name: 'Close', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  const guide = help.locator('[data-slot="accordion-trigger"]').first()
  await expect(guide).toBeFocused()
  await expect(guide).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('Enter')
  await expect(guide).toHaveAttribute('aria-expanded', 'true')
  await expect(help.locator('[data-slot="accordion-content"]').first()).toBeVisible()
  await attach(page, 'help')
  await escapeTo(page, help, account(page))

  // The team window, from the account menu's "Your Inhouse team": it opens quiet and Escape gives focus back to the
  // account button.
  await press(account(page))
  await expect(menu.getByRole('menuitem', { name: 'Your settings' })).toBeFocused()
  await menu.getByRole('menuitem', { name: /^Your Inhouse team/ }).focus()
  await page.keyboard.press('Enter')
  const team = page.getByRole('dialog', { name: 'Your Inhouse team' })
  await opensQuiet(page, team)
  await attach(page, 'team-window')
  await escapeTo(page, team, account(page))

  // Notifications, from the bell: Escape closes only the pop-up.
  const bell = header(page).getByRole('button', { name: /^Notifications/ })
  await press(bell)
  const notices = page.getByRole('dialog', { name: 'Notifications' })
  await expect(notices.getByText('Mark all as read')).toBeVisible()
  await attach(page, 'notifications')
  // The pop-up keeps its Escape: the App's own (close every overlay) never hears it.
  await page.evaluate(() => {
    const w = window as unknown as { escapeReachedWindow?: boolean }
    w.escapeReachedWindow = false
    window.addEventListener('keydown', e => { if (e.key === 'Escape') w.escapeReachedWindow = true })
  })
  await escapeTo(page, notices, bell)
  expect(await page.evaluate(() => (window as unknown as { escapeReachedWindow?: boolean }).escapeReachedWindow)).toBe(false)
})

test('Dark, by keyboard: the problem panel, the trace window, a file viewer and a confirm question open and give focus back', async ({ fx, page }) => {
  // The review window, from a Today card's Review button: opened with focus on itself.
  await open(page, fx, '#/today', '6 things need you')
  const review = page.getByRole('article').filter({ hasText: 'Ridge 30L Pack runs out in 9 days' }).getByRole('button', { name: 'Review' })
  await press(review)
  const panel = page.getByRole('dialog', { name: 'Ridge 30L Pack runs out in 9 days' })
  await opensQuiet(page, panel)
  await attach(page, 'problem-panel')
  await escapeTo(page, panel, review)

  // The trace window, from the Details link in an answer's step list (its steps line opens the list).
  await open(page, fx, '#/chats/stuck', '3 orders · $556')
  const stepsLine = page.locator('main').getByRole('button', { name: /6 steps/ }).last()
  await press(stepsLine)
  await expect(stepsLine).toHaveAttribute('aria-expanded', 'true')
  const steps = stepsLine.locator('xpath=..').getByRole('button', { name: 'Details', exact: true })
  await press(steps)
  const trace = page.getByRole('dialog', { name: /What your Inhouse agent did/ })
  await expect(trace).toContainText('9.4s')
  await opensQuiet(page, trace)
  await attach(page, 'trace-window')
  await escapeTo(page, trace, steps)

  // A Library file viewer, from the first file: the arrow keys step through files while it's open.
  await open(page, fx, '#/library', 'All files')
  const first = page.locator('main [data-file]').first()
  const name = (await first.getAttribute('data-file-id')) ?? ''
  await press(first)
  const viewer = page.getByRole('dialog', { name: /^File: / })
  await opensQuiet(page, viewer)
  await attach(page, 'library-viewer')
  await escapeTo(page, viewer, page.locator(`main [data-file-id="${name}"]`))

  // A confirm question, from Select mode's Delete: Cancel has focus (it's the safe answer), Escape cancels, and focus
  // is back on Delete in the selection bar, with the file still there.
  await press(page.locator('main').getByRole('button', { name: 'Select', exact: true }))
  await press(page.locator(`main [data-file-id="${name}"]`))
  const bar = page.getByRole('toolbar', { name: 'Selected files' })
  await expect(bar).toContainText('1 selected')
  // React writes a bare boolean attribute as "true": what counts is that it's there.
  await expect(bar).toHaveAttribute('data-bottom-dock')
  const del = bar.getByRole('button', { name: 'Delete' })
  await press(del)
  const confirm = page.getByRole('dialog', { name: 'Delete files' })
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await attach(page, 'confirm')
  await escapeTo(page, confirm, del)
  await expect(page.locator(`main [data-file-id="${name}"]`)).toHaveCount(1)
})

test('Dark, by keyboard: a Settings dropdown gives focus back, and a locked switch says why in a tooltip on focus', async ({ fx, page }) => {
  // A Settings dropdown: Enter opens the list, Escape closes only the list.
  await open(page, fx, '#/settings/you-general', 'Profile')
  const select = page.locator('main [role="combobox"]:not([disabled])').first()
  await press(select)
  const list = page.getByRole('listbox')
  await expect(list).toBeVisible()
  await attach(page, 'settings-dropdown')
  await escapeTo(page, list, select)

  // Models: Smart is the default, so its switch is locked on. Tab from its effort picker reaches the switch, the reason
  // shows in a tooltip, and Space doesn't turn it off.
  await open(page, fx, '#/settings/team-modes', 'Models')
  const locked = page.getByRole('switch', { name: 'Smart: the team can use this model' })
  await press(page.getByRole('combobox', { name: /^How hard it thinks: Smart/ }), 'Tab')
  await expect(locked).toBeFocused()
  await expect(locked).toHaveAttribute('aria-disabled', 'true')
  await expect(locked).toHaveAttribute('aria-checked', 'true')
  await expect(tip(page, 'This is the default model').first()).toBeVisible()
  await attach(page, 'locked-switch-reason')
  await page.keyboard.press('Space')
  await expect(locked).toHaveAttribute('aria-checked', 'true')
})

test('Skip to content is the first Tab stop and moves focus into main; the top bar is the banner, outside main', async ({ fx, page }) => {
  await open(page, fx, '#/today', 'Good morning')
  await page.keyboard.press('Tab')
  const skip = page.getByRole('link', { name: 'Skip to content' })
  await expect(skip).toBeFocused()
  // Visible on focus: a real box, not the 1px screen-reader-only one.
  const box = await skip.boundingBox()
  expect(box && box.width > 40 && box.height > 20).toBe(true)
  await attach(page, 'skip-link')
  await page.keyboard.press('Enter')
  await expect(page.locator('main')).toBeFocused()
  expect(await page.evaluate(() => location.hash)).toBe('#/today')
  // The next Tab goes on into the page, not back to the sidebar.
  await page.keyboard.press('Tab')
  expect(await page.evaluate(() => !!document.activeElement?.closest('main'))).toBe(true)
  await expect(page.getByRole('banner')).toHaveCount(1)
  await expect(page.locator('main').getByRole('banner')).toHaveCount(0)
  await expect(page.getByRole('banner').getByRole('button', { name: /^Notifications/ })).toBeVisible()
})

test('Dark, by keyboard: F6 reaches the newest toast and goes back, traps nothing, does nothing over a modal, and the toast still times out', async ({ fx, page }) => {
  // Time runs on the page clock, held while the toasts are made, so no toast times out on a slow run.
  await page.clock.install()
  await open(page, fx, '#/today', '6 things need you')
  const help = page.getByRole('dialog', { name: 'Help and guides' })
  async function openHelp() {
    await press(account(page))
    await press(page.getByRole('menuitem', { name: 'Help and guides' }))
    await expect(help).toBeFocused()
  }
  // Let the lazy Help window load with its timers running before exercising F6 on a paused clock.
  await openHelp()
  await escapeTo(page, help, account(page))

  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 500))
  try {
    const toasts = page.locator('[data-toast-stack] [data-toast]')
    const newestUndo = () => toasts.last().getByRole('button', { name: 'Undo', exact: true })
    /** A toast with Undo, from a Today card's Snooze. */
    async function snooze(title: string) {
      await page.getByRole('article').filter({ hasText: title }).getByRole('button', { name: 'More' }).click()
      await page.getByRole('menuitem', { name: 'Snooze until tomorrow' }).click()
      await expect(page.getByRole('menu')).toHaveCount(0)
    }

    // F6 from a focused control on the page, then Escape: focus is back on it, and Escape closed nothing.
    await snooze('PO-1187 from Kestrel is 6 days late')
    // 4 of its 7 seconds go by first, so a toast that F6 remounted (its countdown started again) would outlast the check below.
    await page.clock.runFor(4000)
    const composer = page.getByRole('textbox', { name: 'Ask Inhouse' })
    await composer.focus()
    await page.keyboard.press('F6')
    await expect(newestUndo()).toBeFocused()
    await attach(page, 'f6-toast')
    await page.keyboard.press('Escape')
    await expect(composer).toBeFocused()
    // The regression check: after F6 and Escape no focus or hover state is left pausing it, and it kept the time it had
    // left, so it times out in the 3 seconds it had.
    await page.clock.runFor(3500)
    await expect(toasts).toHaveCount(0)

    // F6 again goes back too. No trap: after F6 a click elsewhere just works, and the toast times out after it.
    await snooze('Order #4821 is stuck for 4 days')
    await composer.focus()
    await page.keyboard.press('F6')
    await expect(newestUndo()).toBeFocused()
    await page.keyboard.press('F6')
    await expect(composer).toBeFocused()
    await page.keyboard.press('F6')
    await expect(newestUndo()).toBeFocused()
    await page.getByRole('heading', { level: 1 }).click()
    await composer.click()
    await expect(composer).toBeFocused()
    await page.keyboard.type('still typing')
    await expect(composer).toHaveValue('still typing')
    await page.clock.runFor(7500)
    await expect(toasts).toHaveCount(0)

    // Over a modal (a window, a sheet) F6 does nothing: focus stays in it, and the toast is still there with its Undo.
    await snooze('Ridge 30L Pack runs out in 9 days')
    await expect(newestUndo()).toBeVisible()
    await openHelp()
    await page.keyboard.press('F6')
    await expect(help).toBeFocused()
    await expect(newestUndo()).not.toBeFocused()
    await expect(help).toBeVisible()
    await attach(page, 'f6-over-window')
    await page.keyboard.press('Escape')
    await expect(help).toHaveCount(0)
    await expect(newestUndo()).toBeVisible()
  } finally {
    await page.clock.resume()
  }
})

test('Skip to content works with the sidebar collapsed, and its link opened on its own lands on Today with no notice', async ({ fx, page }) => {
  await open(page, fx, '#/activity', 'Activity')
  const toggle = side(page).getByRole('button', { name: 'Sidebar', exact: true })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  // Tab from the top of the page again: the body becomes the starting point for the next Tab.
  await page.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute('tabindex') })
  await page.keyboard.press('Tab')
  const skip = page.getByRole('link', { name: 'Skip to content' })
  await expect(skip).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('main')).toBeFocused()
  // "#main" is an anchor, not a page: opened in a new tab it is Today, and nothing says the page doesn't exist.
  const tab = await page.context().newPage()
  await tab.clock.install()
  await tab.goto('/?demo#main')
  await expect(tab.getByRole('heading', { level: 1 })).toContainText('6 things need you')
  // A route notice would show just after the page draws: give it the time before checking there is none.
  await tab.clock.runFor(1000)
  await expect(tab.locator('[data-toast]')).toHaveCount(0)
  await tab.close()
})
