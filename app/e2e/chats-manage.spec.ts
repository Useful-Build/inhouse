// PR 3, managing chats: rename, pin, copy link and delete with Undo from the sidebar row menu, the top bar menu and
// See all (with Select for several), checked in the sidebar, See all and the top bar, across a reload and Reset demo.
import { expect, fxFor, test } from './support/fx.js'
import type { Page } from '@playwright/test'

async function start(page: Page, hash = '#/today') {
  await fxFor(page, undefined).seed({ demo: { ambient: 'Always' } })
  await page.goto('/?demo' + hash)
}

/** Waits for menus, windows and the toast to finish their finite animations, so a screenshot catches them fully drawn. */
const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.timeline instanceof DocumentTimeline && a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)))
const shot = async (page: Page, name: string) => { await settled(page); await page.screenshot({ path: test.info().outputPath(`${name}.png`) }) }
const side = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' })
const main = (page: Page) => page.locator('main')
const header = (page: Page) => page.getByRole('banner')
const hash = (page: Page) => page.evaluate(() => location.hash)
// The newest toast: the stack keeps earlier ones (a pin, a copied link) until they time out.
const toast = (page: Page) => page.locator('[data-toast]').last()
/** The row (button plus its menu) of a chat in the sidebar or See all, by its title (See all rows also hold the time). */
const row = (scope: ReturnType<typeof side>, title: string) =>
  scope.locator('[data-chat-row]').filter({ has: scope.page().getByRole('button', { name: title }) })
async function rowMenu(scope: ReturnType<typeof side>, title: string, item: string) {
  const r = row(scope, title)
  await r.hover()
  await r.getByRole('button', { name: 'Chat actions' }).click()
  await scope.page().getByRole('menu', { name: 'Chat actions' }).getByRole('menuitem', { name: item }).click()
}
const seeAll = async (page: Page) => {
  await side(page).getByRole('button', { name: 'See all' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'All chats' })).toBeVisible()
}

const OLD = 'Why did refunds jump?'
const NEW = 'Refund spike, week 46'

test('Chats: rename, pin, copy link, delete with Undo and bulk delete, kept across a reload until Reset demo', async ({ page, context, fx }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await start(page)

  // A question from Today starts a chat; its row is marked as running while the answer streams.
  await page.getByRole('textbox', { name: 'Ask Inhouse' }).fill('Where is order 4821?')
  await page.keyboard.press('Enter')
  const startedRow = side(page).getByRole('button', { name: 'Where is order 4821?', exact: true })
  await expect(startedRow).toHaveAccessibleDescription('Answering now')
  await expect(header(page)).toContainText('Where is order 4821?')
  await expect(startedRow).not.toHaveAttribute('aria-describedby', /.+/, { timeout: 15_000 })

  // The started chat has the menu too: rename it from the top bar, Escape cancels and Enter saves.
  await header(page).getByRole('button', { name: 'Chat actions' }).click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  const barField = header(page).getByRole('textbox', { name: 'Chat title' })
  await expect(barField).toBeFocused()
  await barField.fill('Something else')
  await page.keyboard.press('Escape')
  await expect(header(page)).toContainText('Where is order 4821?')
  await header(page).getByRole('button', { name: 'Chat actions' }).click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  await barField.fill('Order 4821')
  await page.keyboard.press('Enter')
  await expect(side(page).getByRole('button', { name: 'Order 4821', exact: true })).toBeVisible()

  // Rename a sample chat from its sidebar menu: the new title shows in the sidebar, See all and the top bar.
  await rowMenu(side(page), OLD, 'Rename')
  const field = side(page).getByRole('textbox', { name: 'Chat title' })
  await expect(field).toBeFocused()
  await field.fill(NEW)
  await page.keyboard.press('Enter')
  await expect(side(page).getByRole('button', { name: NEW, exact: true })).toBeFocused()
  await expect(side(page).getByRole('button', { name: OLD, exact: true })).toHaveCount(0)
  await seeAll(page)
  await expect(row(main(page), NEW)).toHaveCount(1)
  await expect(main(page).getByRole('button', { name: new RegExp(OLD.replace('?', '\\?')) })).toHaveCount(0)
  await side(page).getByRole('button', { name: NEW, exact: true }).click()
  await expect(header(page)).toContainText(NEW)
  expect(await hash(page)).toBe('#/chats/refunds')

  // Pin it from the top bar: it moves under Pinned in the sidebar (and out of Recent chats) and first in See all.
  await header(page).getByRole('button', { name: 'Chat actions' }).click()
  await page.getByRole('menuitem', { name: 'Pin' }).click()
  await expect(toast(page)).toContainText('Chat pinned')
  const pinned = side(page).getByRole('group', { name: 'Pinned' })
  await expect(pinned.getByRole('button', { name: NEW, exact: true })).toBeVisible()
  await expect(side(page).getByRole('group', { name: 'Recent chats' }).getByRole('button', { name: NEW, exact: true })).toHaveCount(0)
  await shot(page, 'chats-manage-pinned-sidebar')

  // Copy link puts the chat's full URL on the clipboard.
  await rowMenu(side(page), NEW, 'Copy link')
  await expect(toast(page)).toContainText('Link copied')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^http:\/\/localhost:\d+\/#\/chats\/refunds$/)

  await seeAll(page)
  const firstSection = main(page).locator('section').first()
  await expect(firstSection).toHaveAttribute('aria-label', 'Pinned')
  await expect(firstSection.getByRole('button', { name: new RegExp(NEW) })).toBeVisible()
  await shot(page, 'chats-manage-see-all-pinned')

  // A reload keeps the title, the pin and the chat started here (decision D7).
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'All chats' })).toBeVisible()
  await expect(firstSection.getByRole('button', { name: new RegExp(NEW) })).toBeVisible()
  await expect(side(page).getByRole('group', { name: 'Pinned' }).getByRole('button', { name: NEW, exact: true })).toBeVisible()
  await expect(side(page).getByRole('button', { name: 'Order 4821', exact: true })).toBeVisible()

  // Delete the open chat from its sidebar menu: the app moves to the newest chat left (the one started here), and the
  // chat is gone everywhere.
  await side(page).getByRole('button', { name: NEW, exact: true }).click()
  await expect(header(page)).toContainText(NEW)
  await rowMenu(side(page), NEW, 'Delete')
  await expect(toast(page)).toContainText('Deleted 1 chat')
  await expect(header(page)).toContainText('Order 4821')
  expect(await hash(page)).toMatch(/^#\/chats\/(?!refunds$|stuck$).+/)
  await expect(side(page).getByRole('button', { name: NEW, exact: true })).toHaveCount(0)
  await expect(side(page).getByRole('group', { name: 'Pinned' })).toHaveCount(0)
  await seeAll(page)
  await expect(main(page).getByRole('button', { name: new RegExp(NEW) })).toHaveCount(0)
  await expect(main(page).locator('section').first()).toHaveAttribute('aria-label', 'Today')
  await shot(page, 'chats-manage-deleted')

  // Undo brings it back, still renamed and pinned (See all stays open: the person moved on from where the delete left them).
  await toast(page).getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(main(page).locator('section').first().getByRole('button', { name: new RegExp(NEW) })).toBeVisible()
  await expect(side(page).getByRole('group', { name: 'Pinned' }).getByRole('button', { name: NEW, exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: 'All chats' })).toBeVisible()

  // Select two chats in See all and delete them; one Undo brings both back.
  await main(page).getByRole('button', { name: 'Select', exact: true }).click()
  const bar = page.getByRole('toolbar', { name: 'Selected chats' })
  await expect(bar).toContainText('Select chats')
  await expect(main(page).getByRole('region', { name: 'Earlier' })).toHaveCount(1)
  await main(page).getByRole('button', { name: /Amazon payout gap/ }).click()
  await main(page).getByRole('button', { name: /Kestrel delivery times/ }).click()
  await expect(bar).toContainText('2 selected')
  await expect(main(page).getByRole('button', { name: /Amazon payout gap/ })).toHaveAttribute('aria-pressed', 'true')
  await shot(page, 'chats-manage-select')
  await bar.getByRole('button', { name: 'Delete' }).click()
  await expect(toast(page)).toContainText('Deleted 2 chats')
  await expect(bar).toHaveCount(0)
  await expect(main(page).getByRole('button', { name: /Amazon payout gap/ })).toHaveCount(0)
  await expect(main(page).getByRole('button', { name: /Kestrel delivery times/ })).toHaveCount(0)
  // Kestrel was the only chat under Earlier, so that group goes with it.
  await expect(main(page).getByRole('region', { name: 'Earlier' })).toHaveCount(0)
  await toast(page).getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(main(page).getByRole('region', { name: 'Earlier' }).getByRole('button', { name: /Kestrel delivery times/ })).toBeVisible()
  await expect(main(page).getByRole('button', { name: /Amazon payout gap/ })).toBeVisible()
  await expect(main(page).getByRole('button', { name: /Kestrel delivery times/ })).toBeVisible()

  // Reset demo clears titles, pins and deletes.
  await rowMenu(main(page), 'Amazon payout gap', 'Delete')
  await expect(toast(page)).toContainText('Deleted 1 chat')
  await page.getByRole('button', { name: /Demo switches/ }).click()
  await page.getByRole('button', { name: 'Reset demo' }).click()
  await page.getByRole('button', { name: 'Close demo switches' }).click()
  await expect(side(page).getByRole('group', { name: 'Pinned' })).toHaveCount(0)
  await expect(side(page).getByRole('button', { name: OLD, exact: true })).toBeVisible()
  await seeAll(page)
  await expect(main(page).locator('section').first()).toHaveAttribute('aria-label', 'Today')
  await expect(main(page).getByRole('button', { name: /Amazon payout gap/ })).toBeVisible()
  await expect(main(page).getByRole('button', { name: new RegExp(NEW) })).toHaveCount(0)
  const { demo: saved } = await fx.saved()
  expect([saved.chatTitles, saved.chatPinned, saved.chatDeleted]).toEqual([{}, {}, {}])
  await shot(page, 'chats-manage-after-reset')
})

test('Chats: the top bar menu has Export, and a new chat with nothing asked has no menu', async ({ page }) => {
  await start(page, '#/chats/payout')
  await expect(header(page)).toContainText('Amazon payout gap')
  await header(page).getByRole('button', { name: 'Chat actions' }).click()
  const menu = page.getByRole('menu', { name: 'Chat actions' })
  const names = ['Rename', 'Pin', 'Copy link', 'Export', 'Delete']
  await expect(menu.getByRole('menuitem')).toHaveCount(names.length)
  for (const [i, n] of names.entries()) await expect(menu.getByRole('menuitem').nth(i)).toHaveAccessibleName(n)
  await shot(page, 'chats-manage-header-menu')
  await menu.getByRole('menuitem', { name: 'Export' }).click()
  await expect(toast(page)).toContainText("Export isn't connected in this demo.")
  // The message menu has no Pin any more.
  await main(page).locator('[data-chat-msg]').last().hover()
  await main(page).getByRole('button', { name: 'More', exact: true }).last().click()
  await expect(page.getByRole('menu', { name: 'Message actions' }).getByRole('menuitem', { name: 'Pin' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  await side(page).getByRole('button', { name: 'New chat' }).click()
  await expect(header(page)).toContainText('New chat')
  await expect(header(page).getByRole('button', { name: 'Chat actions' })).toHaveCount(0)

  // Deleting the only chats left ends in a new chat.
  await seeAll(page)
  await main(page).getByRole('button', { name: 'Select', exact: true }).click()
  const count = await main(page).locator('[data-chat-row]').count()
  expect(count).toBeGreaterThan(1)
  await page.getByRole('toolbar', { name: 'Selected chats' }).getByRole('button', { name: 'Select all' }).click()
  await page.getByRole('toolbar', { name: 'Selected chats' }).getByRole('button', { name: 'Delete' }).click()
  await expect(toast(page)).toContainText(`Deleted ${count} chats`)
  await expect(main(page).getByText('No chats yet', { exact: true })).toBeVisible()
  await expect(side(page).getByRole('group', { name: 'Recent chats' }).getByRole('button')).toHaveCount(0)
  await page.goto('/?demo#/chats')
  await expect(header(page)).toContainText('New chat')
  expect(await hash(page)).toBe('#/chats/new')
})

test('Chats: Tab and Shift+Tab reach a row menu, and focus lands on a real element after a top bar rename, Pin and Delete', async ({ page }) => {
  await start(page, '#/chats/refunds')
  const r = row(side(page), OLD)
  const trigger = r.getByRole('button', { name: 'Chat actions' })
  // The trigger is faded out until hover or focus, yet in the tab order and the accessibility tree.
  await r.getByRole('button', { name: OLD, exact: true }).focus()
  await page.keyboard.press('Tab')
  await expect(trigger).toBeFocused()
  await expect(trigger).toHaveCSS('opacity', '1')
  await r.locator('xpath=following-sibling::*[@data-chat-row][1]').getByRole('button').first().focus()
  await page.keyboard.press('Shift+Tab')
  await expect(trigger).toBeFocused()

  // Escape in the top bar's rename field puts focus back on the chat's menu button.
  await header(page).getByRole('button', { name: 'Chat actions' }).click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  await expect(header(page).getByRole('textbox', { name: 'Chat title' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(header(page).getByRole('button', { name: 'Chat actions' })).toBeFocused()

  // Pin moves the row into Pinned: focus follows it.
  await rowMenu(side(page), OLD, 'Pin')
  await expect(side(page).getByRole('group', { name: 'Pinned' }).getByRole('button', { name: OLD, exact: true })).toBeFocused()

  // Delete (the open chat, in Pinned): focus goes to the next row, not the page.
  await rowMenu(side(page), OLD, 'Delete')
  await expect(toast(page)).toContainText('Deleted 1 chat')
  await expect(side(page).getByRole('button', { name: 'Stuck orders over 3 days', exact: true })).toBeFocused()

  // The last row of Recent chats: focus goes to the row before it.
  const rows = side(page).getByRole('group', { name: 'Recent chats' }).locator('[data-chat-row]')
  const last = rows.last()
  const before = await rows.nth((await rows.count()) - 2).getByRole('button').first().innerText()
  const lastTitle = await last.getByRole('button').first().innerText()
  await rowMenu(side(page), lastTitle, 'Delete')
  await expect(side(page).getByRole('button', { name: lastTitle, exact: true })).toHaveCount(0)
  await expect(side(page).getByRole('group', { name: 'Recent chats' }).locator('[data-chat-row]').getByRole('button', { name: before, exact: true }).first()).toBeFocused()
})

const focused = (page: Page) => page.evaluate(() => document.activeElement === document.body ? 'body' : document.activeElement?.closest('[data-chat-fallback]') ? 'fallback' : document.activeElement?.closest('[data-chat-row]') ? 'row' : document.activeElement?.closest('[data-composer]') ? 'composer' : document.activeElement?.closest('header') ? 'header' : 'other')

test('Chats: focus never drops to the page after deleting from See all, in bulk, from the top bar or the last sidebar row', async ({ page }) => {
  await start(page, '#/chats/refunds')

  // Top bar Delete (the open chat): focus lands on the menu of the chat the bar shows now.
  await header(page).getByRole('button', { name: 'Chat actions' }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await expect(toast(page)).toContainText('Deleted 1 chat')
  await expect(header(page).getByRole('button', { name: 'Chat actions' })).toBeFocused()
  await page.getByRole('button', { name: 'Undo', exact: true }).click()

  // The only row in See all (a search that matches one chat): focus goes to the empty-list note.
  await seeAll(page)
  await main(page).getByRole('searchbox', { name: 'Search chats' }).fill('Amazon payout gap')
  await expect(main(page).locator('[data-chat-row]')).toHaveCount(1)
  await rowMenu(main(page), 'Amazon payout gap', 'Delete')
  await expect(main(page).getByText('No chats match')).toBeVisible()
  await expect.poll(() => focused(page)).toBe('fallback')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await main(page).getByRole('searchbox', { name: 'Search chats' }).fill('')

  // Bulk delete leaving one row: focus goes to that row, not the page.
  await main(page).getByRole('button', { name: 'Select', exact: true }).click()
  const toolbar = page.getByRole('toolbar', { name: 'Selected chats' })
  await toolbar.getByRole('button', { name: 'Select all' }).click()
  const keep = main(page).locator('[data-chat-row]').last()
  const keepTitle = await keep.locator('[data-chat-open]').innerText()
  await keep.locator('[data-chat-open]').click()
  await toolbar.getByRole('button', { name: 'Delete' }).click()
  await expect(toast(page)).toContainText('Deleted')
  await expect(main(page).locator('[data-chat-row]')).toHaveCount(1)
  await expect(main(page).locator('[data-chat-row] [data-chat-open]')).toBeFocused()
  expect(keepTitle.length).toBeGreaterThan(0)

  // Bulk delete of everything: focus goes to the empty-list note. The earlier delete's toast goes first: a delete made
  // while it is still up joins it, and its Undo would then bring back every chat, not only this one.
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0, { timeout: 10_000 })
  await main(page).getByRole('button', { name: 'Select', exact: true }).click()
  await toolbar.getByRole('button', { name: 'Select all' }).click()
  await toolbar.getByRole('button', { name: 'Delete' }).click()
  await expect(main(page).getByText('No chats yet', { exact: true })).toBeVisible()
  await expect.poll(() => focused(page)).toBe('fallback')

  // Undo brings a chat back; as the last Recent row, with no other group, its delete hands focus to New chat (with no
  // chats left the sidebar has no Recent chats heading or See all).
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  const sideRows = side(page).getByRole('group', { name: 'Recent chats' }).locator('[data-chat-row]')
  await expect(sideRows).toHaveCount(1)
  await rowMenu(side(page), await sideRows.locator('[data-chat-open]').innerText(), 'Delete')
  await expect(side(page).getByRole('group', { name: 'Recent chats' })).toHaveCount(0)
  await expect(side(page).getByRole('button', { name: 'New chat', exact: true })).toBeFocused()

  // Deleting the open last chat from the top bar ends in a new chat with the composer focused.
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await side(page).getByRole('group', { name: 'Recent chats' }).locator('[data-chat-open]').click()
  await header(page).getByRole('button', { name: 'Chat actions' }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await expect(header(page)).toContainText('New chat')
  await expect.poll(() => focused(page)).not.toBe('body')
  await expect.poll(() => focused(page)).toBe('composer')
})
