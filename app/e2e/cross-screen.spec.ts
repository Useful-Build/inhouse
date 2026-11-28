// Chats keep what was added and new chats stay listed, saved settings reach
// other screens, focus returns, chat URLs, and the Library's selection, Undo, Escape, counts and data check.
import { expect, fxFor, test } from './support/fx.js'
import type { Page } from '@playwright/test'
import { atRest } from './states.js'

async function start(page: Page, hash = '#/today') {
  await fxFor(page, undefined).seed({ demo: { ambient: 'Always' } })
  await page.goto('/?demo' + hash)
}

const out = process.env.VERIFY_DIR ?? 'e2e-artifacts'
/** A screenshot kept next to the report, under a fixed name. */
const keep = async (page: Page, name: string, fullPage = false) => { await atRest(page); await page.screenshot({ path: `${out}/${name}.png`, fullPage }) }
const side = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' })
const main = (page: Page) => page.locator('main')
const hash = (page: Page) => page.evaluate(() => location.hash)
const askInChat = async (page: Page, q: string) => {
  await page.getByRole('textbox', { name: 'Message Inhouse' }).fill(q)
  await page.keyboard.press('Enter')
  await expect(main(page).locator('[data-chat-msg]').getByText(q, { exact: true })).toBeVisible()
}
const askFromToday = async (page: Page, q: string) => {
  await page.getByRole('textbox', { name: 'Ask Inhouse' }).fill(q)
  await page.keyboard.press('Enter')
  await expect(main(page).locator('[data-chat-msg]').getByText(q, { exact: true })).toBeVisible()
}

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

test('Chats: reopening the open chat keeps what was added, from See all and from the highlighted row', async ({ page }) => {
  await start(page)
  await side(page).getByRole('button', { name: 'Why did refunds jump?', exact: true }).click()
  await askInChat(page, 'And what about last week?')

  await side(page).getByRole('button', { name: 'See all' }).click()
  await page.getByRole('main').getByRole('button', { name: /Why did refunds jump/ }).click()
  await expect(main(page).getByText('And what about last week?', { exact: true })).toBeVisible()
  const row = side(page).getByRole('button', { name: 'Why did refunds jump?', exact: true })
  await expect(row).toHaveAttribute('aria-current', 'page')
  await row.click()
  await expect(main(page).getByText('And what about last week?', { exact: true })).toBeVisible()

  // The newest chat is open with no id yet (#/chats): the highlighted row must keep a question too.
  await page.goto('/?demo#/chats')
  await expect(page.getByRole('banner')).toContainText('Full catalog margin review')
  await askInChat(page, 'Which one is oldest?')
  const newest = side(page).getByRole('button', { name: 'Full catalog margin review', exact: true })
  await expect(newest).toHaveAttribute('aria-current', 'page')
  await newest.click()
  await expect(main(page).getByText('Which one is oldest?', { exact: true })).toBeVisible()
  await keep(page, 'chat-reopen-1440')
})

test('Chats: a chat started from Today, a tool page or New chat is kept, newest first, and each question gets its own chat', async ({ page }) => {
  await start(page)
  await askFromToday(page, 'Where is order 4821?')
  await expect(page.getByRole('banner')).toContainText('Where is order 4821?')
  await side(page).getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Today' }).click()
  await askFromToday(page, 'How many returns came in?')

  // A tool page starts its own chat too.
  await page.goto('/?demo#/tools/shopify')
  await main(page).locator('button[data-tool-example]').first().click()
  const header = page.getByRole('banner').locator('[data-topbar-title]')
  await expect(header).not.toHaveText('Today')
  const toolQ = (await header.innerText()).trim()
  await expect(main(page).locator('[data-chat-msg]').first()).toContainText(toolQ.replace(/…$/, ''))
  await side(page).getByRole('button', { name: 'New chat' }).click()
  await askInChat(page, 'Anything unusual in Xero?')

  // They are in Recent chats, newest first, ahead of the sample chats.
  await side(page).getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Today' }).click()
  const titles = ['Anything unusual in Xero?', toolQ, 'How many returns came in?', 'Where is order 4821?']
  const recent = side(page).getByRole('button').filter({ hasText: new RegExp('^(' + titles.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')$') })
  await expect(recent).toHaveText(titles)

  // The first one still has its own question, and only that one.
  await side(page).getByRole('button', { name: 'Where is order 4821?', exact: true }).click()
  await expect(main(page).locator('[data-chat-msg]').getByText('Where is order 4821?', { exact: true })).toBeVisible()
  await expect(main(page).getByText('How many returns came in?')).toHaveCount(0)

  // See all lists them under Today, newest first.
  await side(page).getByRole('button', { name: 'See all' }).click()
  const today = main(page).getByRole('region', { name: 'Today' })
  await expect(today.locator('[data-chat-open]').nth(0)).toContainText('Anything unusual in Xero?')
  await expect(today.locator('[data-chat-open]').nth(3)).toContainText('Where is order 4821?')
  await main(page).getByRole('searchbox', { name: 'Search chats' }).fill('returns came')
  await expect(main(page).getByRole('button', { name: /How many returns came in/ })).toBeVisible()
  await expect(main(page).getByRole('button', { name: /Where is order 4821/ })).toHaveCount(0)
})

test('Chats: a new chat starts clean, with no old reply and the default model', async ({ page }) => {
  await start(page)
  await side(page).getByRole('button', { name: 'Why did refunds jump?', exact: true }).click()
  const answer = main(page).locator('[data-chat-msg]').filter({ hasText: 'Refund requests rose' }).last()
  await answer.hover()
  await answer.getByRole('button', { name: 'Reply', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop replying' })).toBeVisible()

  await side(page).getByRole('button', { name: 'New chat' }).click()
  await expect(page.getByRole('button', { name: 'Stop replying' })).toHaveCount(0)
  await askInChat(page, 'Start fresh please')
  await expect(main(page).getByText('Refund requests rose')).toHaveCount(0)
})

test('Settings reach other screens: model, spending cap, alert level and member roles', async ({ page }) => {
  await start(page, '#/settings/team-modes')
  await page.getByRole('combobox', { name: 'Default model: Smart' }).click()
  await page.getByRole('option', { name: 'Max' }).click()
  await side(page).getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Today' }).click()
  await expect(page.getByRole('button', { name: 'Model: Max' })).toBeVisible()
  await side(page).getByRole('button', { name: 'New chat' }).click()
  await expect(page.getByRole('button', { name: 'Model: Max' })).toBeVisible()

  await page.goto('/?demo#/settings/team-spend')
  const cap = page.getByRole('textbox', { name: 'Monthly cap' })
  await cap.fill('$300')
  await cap.blur()
  await page.getByRole('combobox', { name: 'Alert at: 80%' }).click()
  await page.getByRole('option', { name: '90%' }).click()
  await page.goto('/?demo#/usage')
  await expect(page.getByText('$78.40 of $300')).toBeVisible()
  await expect(page.getByText('Admins get an email at 90%')).toBeVisible()

  // A low cap: this month's spend is already above it, so it shows the capped state.
  await page.goto('/?demo#/settings/team-spend')
  await page.getByRole('textbox', { name: 'Monthly cap' }).fill('$50')
  await page.getByRole('textbox', { name: 'Monthly cap' }).blur()
  await page.goto('/?demo#/usage')
  await expect(page.getByText('$78.40 of $50', { exact: true })).toBeVisible()
  await expect(page.getByText('Cap reached with 14 days of the month left')).toBeVisible()
  await expect(page.getByText(/On track/)).toHaveCount(0)
  await keep(page, 'usage-1440', true)
  // November is the first month with spend (the first tool was connected on Nov 2), the only one: no month picker.
  await expect(page.getByRole('combobox', { name: /^Month/ })).toHaveCount(0)
})

test('Focus: Clear search goes back to the box, a dropdown closed from outside goes back to its button, Help closes to Settings', async ({ page }) => {
  await start(page, '#/tools')
  const search = page.getByRole('searchbox', { name: 'Search tools' })
  await search.fill('ship')
  await page.getByRole('button', { name: 'Clear search' }).click()
  await expect(search).toBeFocused()
  await expect(search).toHaveValue('')

  await page.goto('/?demo#/settings/you-general')
  await page.clock.install() // before the list opens, so its setTimeout(0) below runs on the page clock (time keeps flowing)
  const zone = page.getByRole('combobox', { name: 'Time zone: Eastern Time (New York)' })
  await expect(zone).not.toHaveAttribute('aria-controls', /.+/)
  await zone.click()
  const list = page.getByRole('listbox', { name: 'Time zone' })
  const id = await list.getAttribute('id')
  expect(id).toBeTruthy()
  // While the list is open, Radix hides the rest of the page (the button included) from the accessibility tree.
  await expect(page.getByRole('combobox', { name: 'Time zone: Eastern Time (New York)', includeHidden: true })).toHaveAttribute('aria-controls', id!)
  // Radix attaches its outside-click listener in a setTimeout(0) after the list mounts; let it, or the click is missed.
  await page.clock.runFor(1)
  await page.mouse.click(720, 600)
  await expect(list).toHaveCount(0)
  await expect(zone).toBeFocused()

  const settings = side(page).getByRole('button', { name: /account and settings/i })
  await settings.click()
  await page.getByRole('menuitem', { name: 'Help and guides' }).click()
  await expect(page.getByRole('dialog', { name: 'Help and guides' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Help and guides' })).toHaveCount(0)
  await expect(settings).toBeFocused()
})

test('Chat URLs: See all and each chat have their own address, Back and Forward move between them, a reload keeps the view', async ({ page }) => {
  await start(page)
  await side(page).getByRole('button', { name: 'See all' }).click()
  expect(await hash(page)).toBe('#/chats/all')
  await main(page).getByRole('button', { name: /Why did refunds jump/ }).click()
  expect(await hash(page)).toBe('#/chats/refunds')
  await expect(page.getByRole('banner')).toContainText('Why did refunds jump?')
  await side(page).getByRole('button', { name: "What to feature in Friday's email", exact: true }).click()
  expect(await hash(page)).toBe('#/chats/friday')

  await page.goBack()
  await expect(page.getByRole('banner')).toContainText('Why did refunds jump?')
  await page.goBack()
  await expect(page.getByRole('heading', { level: 1, name: 'All chats' })).toBeVisible()
  expect(await hash(page)).toBe('#/chats/all')
  await page.goForward()
  await expect(page.getByRole('banner')).toContainText('Why did refunds jump?')
  await page.reload()
  await expect(page.getByRole('banner')).toContainText('Why did refunds jump?')
  expect(await hash(page)).toBe('#/chats/refunds')
  await page.goto('/?demo#/chats/all')
  await expect(page.getByRole('heading', { level: 1, name: 'All chats' })).toBeVisible()

  // The old link and a stale one open the newest chat.
  await page.goto('/?demo#/chats')
  await expect(page.getByRole('banner')).toContainText('Full catalog margin review')
  await expect.poll(() => hash(page)).toBe('#/chats/catalog-audit')
  await page.goto('/?demo#/chats/not-a-chat')
  await expect(page.getByRole('banner')).toContainText('Full catalog margin review')
  await expect.poll(() => hash(page)).toBe('#/chats/catalog-audit')

  // A chat that was just started is reachable with Back after the first question, and Back skips the empty chat.
  await page.goto('/?demo#/today')
  await side(page).getByRole('button', { name: 'New chat' }).click()
  expect(await hash(page)).toBe('#/chats/new')
  await askInChat(page, 'Is the warehouse backed up?')
  await expect.poll(() => hash(page)).toMatch(/^#\/chats\/chat-new-[a-z0-9]+-\d+$/)
  await page.goBack()
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Today' })).toHaveAttribute('aria-current', 'page')
})

test('Library: a pick clears when the tab, place or search changes; two deletes share one Undo; Escape leaves Select; counts follow the search', async ({ page }) => {
  await start(page, '#/library')
  const cards = page.getByRole('list', { name: 'Files' }).getByRole('listitem')
  const tabs = page.getByRole('radiogroup', { name: 'File type' })
  const bar = page.getByRole('toolbar', { name: 'Selected files' })
  // The Library loads on first visit (its own chunk): count once its cards are in.
  await expect(cards.first()).toBeVisible()
  const total = await cards.count()
  await page.getByRole('button', { name: 'Select', exact: true }).click()
  await cards.nth(0).click()
  await cards.nth(1).click()
  await expect(bar).toContainText('2 selected')
  await tabs.getByRole('radio', { name: /^Documents/ }).click()
  await expect(bar).toContainText('Select files')
  await tabs.getByRole('radio', { name: /^All/ }).click()
  await cards.nth(0).click()
  await expect(bar).toContainText('1 selected')
  await page.getByRole('navigation', { name: 'Library places' }).getByRole('button', { name: /^Routines/ }).click()
  await expect(bar).toContainText('Select files')
  await page.getByRole('navigation', { name: 'Library places' }).getByRole('button', { name: /^All files/ }).click()
  await cards.nth(0).click()
  await page.getByRole('searchbox', { name: 'Search library' }).fill('csv')
  await expect(bar).toContainText('Select files')
  await page.getByRole('searchbox', { name: 'Search library' }).fill('')

  // Escape: the delete question first, then Select mode.
  await cards.nth(0).click()
  await bar.getByRole('button', { name: 'Delete' }).click()
  const confirm = page.getByRole('dialog', { name: 'Delete files' })
  await expect(confirm).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(confirm).toHaveCount(0)
  await expect(bar).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(bar).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toBeVisible()

  // Two deletes in a row: one toast, one Undo that brings back both.
  const del = async (n: number) => {
    await page.getByRole('button', { name: 'Select', exact: true }).click()
    await cards.nth(n).click()
    await bar.getByRole('button', { name: 'Delete' }).click()
    await page.getByRole('dialog', { name: 'Delete files' }).getByRole('button', { name: 'Delete', exact: true }).click()
  }
  await del(0)
  await expect(page.getByText('Deleted 1 file')).toBeVisible()
  await del(0)
  await expect(page.getByText('Deleted 2 files')).toBeVisible()
  await expect(cards).toHaveCount(total - 2)
  await page.locator('[data-toast]').filter({ hasText: 'Deleted 2 files' }).getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(cards).toHaveCount(total)

  // Counts match what is shown, for every tab, while a search is on.
  await page.getByRole('searchbox', { name: 'Search library' }).fill('morning')
  for (const name of ['All', 'Images', 'Documents', 'Code', 'Audio and video', 'Other']) {
    const t = tabs.getByRole('radio', { name: new RegExp(`^${name} \\d+$`) })
    const n = Number((await t.innerText()).replace(/\D/g, ''))
    await t.click()
    if (n === 0) await expect(page.getByText(/No files match/)).toBeVisible()
    else await expect(cards).toHaveCount(n)
  }
})

test('Library: sample data with an unknown place stops the app with a message', async ({ page }) => {
  // Break one file's place in the built bundle, as bad JSON would.
  await page.route('**/assets/*.js', async route => {
    const res = await route.fetch()
    const body = await res.text()
    await route.fulfill({ response: res, body: body.replace(/(place["']?\s*:\s*)([`"'])approvals\2/, '$1$2nowhere$2') })
  })
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await start(page, '#/library')
  await expect.poll(() => errors.join(' ')).toContain('unknown place "nowhere"')
})

test('Demo switcher: no page puts a control under it at 1440', async ({ page }) => {
  await start(page, '#/library')
  for (const hash of ['#/library', '#/settings/you-general', '#/today', '#/chats/refunds', '#/usage', '#/approvals']) {
    await page.goto('/?demo' + hash)
    await expect(page.getByRole('button', { name: /^Demo switches/ })).toBeVisible()
    await nothingUnderSwitcher(page)
  }
  await page.goto('/?demo#/library')
  await keep(page, 'library-1440')
})
