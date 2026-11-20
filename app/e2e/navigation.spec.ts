// PR 5, navigation (desktop): the ⌘K palette (a chat, a settings page, New chat, focus back on Escape), the shortcuts,
// the collapsible sidebar and its icon rail across a reload, notifications read one at a time and all at once, and the
// team window's Send and sender.
import { expect, test, type Fx } from './support/fx.js'
import type { Page } from '@playwright/test'

async function start(page: Page, fx: Fx, hash = '#/today') {
  await fx.seed({ stage: 'Act', demo: { ambient: 'Always' } })
  await page.goto('/?demo' + hash)
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
}

const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)))
const shot = async (page: Page, name: string) => { await settled(page); await page.screenshot({ path: test.info().outputPath(`${name}.png`) }) }
const side = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' })
const header = (page: Page) => page.getByRole('banner')
const hash = (page: Page) => page.evaluate(() => location.hash)
const palette = (page: Page) => page.getByRole('dialog', { name: 'Search' })
const paletteInput = (page: Page) => palette(page).getByRole('combobox')
/** The open tooltip with this text (one that is closing can still be in the page for a moment). */
const tip = (page: Page, text: string | RegExp) => page.getByRole('tooltip').filter({ hasText: text })
const composer = (page: Page) => page.getByRole('textbox', { name: /^(Ask|Message) your Inhouse agent$/ })

test('Palette: open a chat and a settings page, run New chat, Escape gives focus back; shortcuts skip fields except ⌘K', async ({ fx, page }) => {
  await start(page, fx)

  // ⌘K opens it with the search field focused; filter to one chat and open it with Enter.
  await page.keyboard.press('ControlOrMeta+k')
  await expect(palette(page)).toBeVisible()
  await expect(paletteInput(page)).toBeFocused()
  for (const g of ['Pages', 'Settings', 'Chats', 'Actions']) await expect(palette(page).getByText(g, { exact: true })).toBeVisible()
  await paletteInput(page).fill('refunds jump')
  await expect(palette(page).getByRole('option')).toHaveCount(1)
  await expect(palette(page).getByRole('option', { name: 'Why did refunds jump?' })).toHaveAttribute('aria-selected', 'true')
  await shot(page, 'palette-chat-filter')
  await page.keyboard.press('Enter')
  await expect(palette(page)).toHaveCount(0)
  await expect.poll(() => hash(page)).toBe('#/chats/refunds')
  await expect(header(page)).toContainText('Why did refunds jump?')

  // Again, to a settings page, moving with the arrows: the first match is picked, ArrowDown and ArrowUp come back to it.
  await page.keyboard.press('ControlOrMeta+k')
  await paletteInput(page).fill('members')
  const members = palette(page).getByRole('option', { name: 'Members' })
  await expect(members).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowUp')
  await expect(members).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect.poll(() => hash(page)).toBe('#/settings/team-members')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Members')

  // Run New chat from its Actions.
  await page.keyboard.press('ControlOrMeta+k')
  await paletteInput(page).fill('new chat')
  await expect(palette(page).getByRole('option', { name: /New chat/ })).toContainText(/⌘⇧O|Ctrl\+Shift\+O/)
  await page.keyboard.press('Enter')
  await expect.poll(() => hash(page)).toBe('#/chats/new')
  await expect(header(page)).toContainText('New chat')

  // The visible entry: the top bar's Search, with ⌘K in its tooltip. Escape closes the palette and focus goes back to it.
  const search = header(page).getByRole('button', { name: 'Search' })
  await search.hover()
  await expect(tip(page, /Search\s*(⌘K|Ctrl\+K)/)).toBeVisible()
  await search.click()
  await expect(palette(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(palette(page)).toHaveCount(0)
  await expect(search).toBeFocused()

  // ⌘K works while typing; Escape puts focus back in the field, with the draft kept.
  await composer(page).fill('half a question')
  await page.keyboard.press('ControlOrMeta+k')
  await expect(palette(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(composer(page)).toBeFocused()
  await expect(composer(page)).toHaveValue('half a question')

  // ⌘⇧O doesn't fire while typing, and does from the page.
  await page.goto('/?demo#/today')
  await composer(page).fill('typing here')
  await page.keyboard.press('ControlOrMeta+Shift+O')
  await expect.poll(() => hash(page)).toBe('#/today')
  await page.locator('main').focus()
  await page.keyboard.press('ControlOrMeta+Shift+O')
  await expect.poll(() => hash(page)).toBe('#/chats/new')
})

test('Palette over the problem panel: Escape closes only the palette; the palette search ignores internal ids', async ({ fx, page }) => {
  await start(page, fx)
  await page.getByRole('article', { name: 'Ridge 30L Pack runs out in 9 days' }).getByRole('button', { name: 'Review' }).click()
  const panel = page.getByRole('dialog').filter({ hasText: 'Ridge 30L Pack' })
  await expect(panel).toBeVisible()
  await page.keyboard.press('ControlOrMeta+k')
  await expect(palette(page)).toBeVisible()
  await expect(paletteInput(page)).toBeFocused()
  // Words that are only in an item's internal value find nothing; a hidden keyword finds Thinking modes (Models).
  await paletteInput(page).fill('chat refunds')
  await expect(palette(page).getByText('No pages, chats or actions match.')).toBeVisible()
  await paletteInput(page).fill('thinking')
  await expect(palette(page).getByRole('option').first()).toHaveAttribute('data-value', 'settings:team-modes')
  await page.keyboard.press('Escape')
  await expect(palette(page)).toHaveCount(0)
  await expect(panel).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
})

test('Sidebar: Tab from a chat row reaches its menu trigger, a cut title shows in full, the account name starts with its text', async ({ fx, page }) => {
  await start(page, fx)
  const toggle = page.getByRole('button', { name: 'Sidebar', exact: true })
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(toggle).toHaveAttribute('aria-controls', 'sidebar')
  await expect(side(page)).toHaveAttribute('id', 'sidebar')

  const row = side(page).locator('[data-chat-row]').first()
  const open = row.locator('[data-chat-open]')
  await open.focus()
  await page.keyboard.press('Tab')
  const trigger = row.locator('[aria-haspopup="menu"]')
  await expect(trigger).toBeFocused()
  await expect(trigger).toHaveCSS('opacity', '1')

  // A short title gets no tooltip. One that fits at rest but runs under the trigger on hover gets one.
  const t = open.locator('.ellipsis')
  await t.evaluate(e => { e.textContent = 'Refunds' })
  await page.mouse.move(720, 450)
  // Radix dispatches `tooltip.open` on the document once the open delay has passed, even when the row declines to open
  // because the title isn't cut. Wait for that event (no clock, no fixed wait), then one frame for React's commit.
  // Wrapped in an object: evaluateHandle would otherwise wait for the promise itself.
  const delayPassed = await page.evaluateHandle(() => ({ done: new Promise<void>(r => document.addEventListener('tooltip.open', () => r(), { once: true })) }))
  await open.hover()
  await delayPassed.evaluate(o => o.done)
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))))
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  // A fresh page for the cut title, so no tooltip state from the hover above (or the earlier Tab) carries over.
  await page.reload()
  await t.evaluate(e => { e.textContent = 'Refunds' })
  const cutAtRest = await t.evaluate(e => {
    const menu = e.closest('[data-chat-row]')!.querySelector<HTMLElement>('[aria-haspopup="menu"]')!
    const room = menu.getBoundingClientRect().left - e.getBoundingClientRect().left
    const text = () => { const r = document.createRange(); r.selectNodeContents(e); return r.getBoundingClientRect().width }
    // Grow the title until it is just past the trigger's left edge, still inside its own box.
    let s = 'Refunds'
    while (text() <= room + 1 && s.length < 200) { s += ' x'; e.textContent = s }
    return e.scrollWidth > e.clientWidth
  })
  expect(cutAtRest).toBe(false)
  await page.mouse.move(720, 450)
  await open.hover()
  await expect(page.getByRole('tooltip')).toBeVisible()

  const account = side(page).getByRole('button', { name: /account and settings/i })
  // Its visible text: the name, without the icon's ligature after it.
  const visible = (await account.innerText()).split('\n')[0].trim()
  expect(visible).toBe('Sam Mercer')
  expect(visible.length).toBeGreaterThan(0)
  await expect(account).toHaveAccessibleName(new RegExp('^' + visible.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('Sidebar: collapse to the rail, move through it by its tooltips, stay collapsed after a reload, expand with the shortcut', async ({ fx, page }) => {
  await start(page, fx)
  const collapse = page.getByRole('button', { name: 'Sidebar', exact: true })
  await collapse.hover()
  await expect(tip(page, /Collapse sidebar\s*(⌘\\|Ctrl\+\\)/)).toBeVisible()
  await collapse.click()
  const box = (await side(page).boundingBox())!
  expect(box.width).toBeLessThan(80)
  await expect(page.getByRole('button', { name: 'Sidebar', exact: true })).toHaveAttribute('aria-expanded', 'false')
  await expect(side(page).getByText('Recent chats')).toHaveCount(0)
  await shot(page, 'sidebar-rail')

  // Each rail item is named in a tooltip; the waiting count stays in Approvals' name and shows as a dot.
  const approvals = side(page).getByRole('button', { name: /^Approvals/ })
  await expect(approvals).toHaveAccessibleName(/Approvals\s*\d+ waiting/)
  // Off the rail first: a one-step move from one item to the next stays inside Radix's tooltip grace area.
  const away = () => page.mouse.move(720, 450)
  await away()
  await approvals.hover()
  await expect(tip(page, /^Approvals$/)).toBeVisible()
  await approvals.click()
  await expect.poll(() => hash(page)).toBe('#/approvals')
  await expect(approvals).toHaveAttribute('aria-current', 'page')
  const usage = side(page).getByRole('button', { name: 'Usage' })
  // Radix can skip the first move onto a trigger right after another tooltip closed; move again until it opens.
  await expect(async () => {
    await away()
    await usage.hover()
    await expect(tip(page, /^Usage$/)).toBeVisible({ timeout: 1500 })
  }).toPass()
  await usage.click()
  await expect.poll(() => hash(page)).toBe('#/usage')
  // The account avatar opens the account menu from the rail.
  await side(page).getByRole('button', { name: /account and settings/i }).click()
  await expect(page.getByRole('menu', { name: 'Account' })).toBeVisible()
  await page.keyboard.press('Escape')

  await page.reload()
  await expect(page.getByRole('button', { name: 'Sidebar', exact: true })).toHaveAttribute('aria-expanded', 'false')
  expect((await side(page).boundingBox())!.width).toBeLessThan(80)

  await page.locator('main').focus()
  await page.keyboard.press('ControlOrMeta+\\')
  await expect(page.getByRole('button', { name: 'Sidebar', exact: true })).toHaveAttribute('aria-expanded', 'true')
  await expect(side(page).getByText('Recent chats')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Sidebar', exact: true })).toHaveAttribute('aria-expanded', 'true')
})

test('Notifications: one read by clicking it drops the count in the bell, Mark all as read shows the empty state', async ({ fx, page }) => {
  await start(page, fx)
  const bell = header(page).getByRole('button', { name: /^Notifications/ })
  await expect(bell).toHaveAccessibleName('Notifications, 2 unread')
  await bell.click()
  const pop = page.getByRole('dialog', { name: 'Notifications' })
  await expect(pop.getByText('Unread')).toHaveCount(2)
  await pop.getByRole('button', { name: /drafts are waiting for your approval/ }).click()
  await expect.poll(() => hash(page)).toBe('#/approvals')
  await expect(bell).toHaveAccessibleName('Notifications, 1 unread')

  await bell.click()
  await expect(pop.getByText('Unread')).toHaveCount(1)
  await pop.getByRole('button', { name: 'Mark all as read' }).click()
  // Nothing unread, but the drafts line still says something is waiting, so "all caught up" doesn't show above it (L11).
  await expect(pop.getByText("You're all caught up")).toHaveCount(0)
  await expect(pop.getByRole('button', { name: 'Mark all as read' })).toHaveCount(0)
  await expect(bell).toHaveAccessibleName('Notifications')
  await shot(page, 'notifications-caught-up')
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(header(page).getByRole('button', { name: /^Notifications/ })).toHaveAccessibleName('Notifications')
})

test('Team window: Send waits for words (whitespace is empty), and the request carries the name set in Settings', async ({ fx, page }) => {
  await start(page, fx, '#/settings/you-general')
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Robin Okafor')
  await expect(side(page).getByRole('button', { name: /account and settings/i })).toContainText('Robin Okafor')

  await page.keyboard.press('ControlOrMeta+k')
  await paletteInput(page).fill('message the team')
  await page.keyboard.press('Enter')
  const team = page.getByRole('dialog', { name: 'Your Inhouse team' })
  await expect(team).toBeVisible()
  const send = team.getByRole('button', { name: 'Send to the team' })
  const text = team.getByRole('textbox', { name: 'Your request' })
  await expect(send).toBeDisabled()
  await text.fill('   \n  ')
  await expect(send).toBeDisabled()
  await text.fill('Connect our Gorgias macros')
  await expect(send).toBeEnabled()
  await send.click()
  await expect(team).toHaveCount(0)
  await expect(page.locator('[data-toast]').filter({ hasText: 'Request sent' })).toBeVisible()

  await side(page).getByRole('button', { name: 'Message the team →' }).click()
  await expect(team.getByText('Connect our Gorgias macros')).toBeVisible()
  await expect(team.getByText('New tool · sent by Robin Okafor, just now')).toBeVisible()
  await shot(page, 'team-sent-by-name')
})
