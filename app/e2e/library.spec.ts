// Library: sidebar slot, tabs and counts, places, search, views, the viewer and its link back, Select, Delete and Undo.
import { expect, fxFor, test } from './support/fx.js'
import type { Page } from '@playwright/test'
import { atRest } from './states.js'

async function start(page: Page, hash = '#/library') {
  await fxFor(page, undefined).seed({ demo: { ambient: 'Always' } })
  await page.goto('/?demo' + hash)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(hash === '#/library' ? 'All files' : /things need you/)
}

const TABS = ['All', 'Images', 'Documents', 'Code', 'Audio and video', 'Other']
const tabs = (page: Page) => page.getByRole('radiogroup', { name: 'File type' })
const tab = (page: Page, name: string) => tabs(page).getByRole('radio', { name: new RegExp(`^${name} \\d+$`) })
const places = (page: Page) => page.getByRole('navigation', { name: 'Library places' })
const cards = (page: Page) => page.getByRole('list', { name: 'Files' }).getByRole('listitem')
const view = (page: Page, name: string) => page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name })
const shot = async (page: Page, name: string) => { await atRest(page); await page.screenshot({ path: test.info().outputPath(`${name}.png`) }) }
const countOf = async (page: Page, name: string) => Number((await tab(page, name).innerText()).replace(/\D/g, ''))

test('Library is in the sidebar, fourth in the first group after Activity, and Chats is not', async ({ page }) => {
  await start(page, '#/today')
  const nav = page.getByRole('navigation', { name: 'Main' })
  await expect(nav.getByRole('button').nth(0)).toContainText('Today')
  await expect(nav.getByRole('button').nth(3)).toHaveText(/Library$/)
  await expect(nav.getByRole('group', { name: 'Your agent' }).getByRole('button', { name: 'Library' })).toHaveCount(0)
  await expect(page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Chats', exact: true })).toHaveCount(0)
  await nav.getByRole('button', { name: 'Library' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('All files')
  await expect(nav.getByRole('button', { name: 'Library' })).toHaveAttribute('aria-current', 'page')
  expect(new URL(page.url()).hash).toBe('#/library')
})

test('Tabs filter the files and their counts match what shows', async ({ page }) => {
  await start(page)
  await expect(tabs(page).getByRole('radio')).toHaveText(TABS.map(t => new RegExp(`^${t} \\d+$`)))
  const total = await countOf(page, 'All')
  expect(total).toBeGreaterThanOrEqual(30)
  expect(total).toBeLessThanOrEqual(50)
  await expect(cards(page)).toHaveCount(total)
  let sum = 0
  for (const t of TABS.slice(1)) {
    const n = await countOf(page, t)
    expect(n, `${t} keeps its tab even when small`).toBeGreaterThan(0)
    sum += n
    await tab(page, t).click()
    await expect(tab(page, t)).toHaveAttribute('aria-checked', 'true')
    await expect(cards(page)).toHaveCount(n)
  }
  expect(sum).toBe(total)
  await tab(page, 'Images').click()
  await expect(cards(page).filter({ hasText: 'trail-shell-jacket-olive' })).toHaveCount(1)
  await shot(page, 'library-images')
  await expect(cards(page).filter({ hasText: 'weekly-ops-report' })).toHaveCount(0)
  await tab(page, 'Audio and video').click()
  await expect(cards(page).filter({ hasText: 'kestrel-call-nov-3.m4a' })).toHaveCount(1)
  await expect(cards(page).filter({ hasText: 'packing-bench-walkthrough.mp4' })).toHaveCount(1)
})

test('Places filter the files, the title follows and the counts add up', async ({ page }) => {
  await start(page)
  const all = await countOf(page, 'All')
  const names = ['Chats', 'Routines', 'Approvals', 'Uploaded by the team']
  let sum = 0
  for (const n of names) {
    const btn = places(page).getByRole('button', { name: new RegExp(`^${n} \\d+$`) })
    const c = Number((await btn.innerText()).replace(/\D/g, ''))
    sum += c
    await btn.click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(n)
    await expect(btn).toHaveAttribute('aria-pressed', 'true')
    expect(await countOf(page, 'All')).toBe(c)
    await expect(cards(page)).toHaveCount(c)
  }
  expect(sum).toBe(all)
  // Approvals are all documents: the other tabs stay, empty.
  await places(page).getByRole('button', { name: /^Approvals/ }).click()
  await tab(page, 'Images').click()
  await expect(page.getByText('No files under Images here yet.')).toBeVisible()
  await places(page).getByRole('button', { name: /^All files/ }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('All files')
})

test('Search filters by name across the current tab and place, and has an empty state', async ({ page }) => {
  await start(page)
  const box = page.getByRole('searchbox', { name: 'Search library' })
  await box.fill('kestrel')
  const n = await cards(page).count()
  expect(n).toBeGreaterThanOrEqual(3)
  for (const t of await cards(page).allInnerTexts()) expect(t.toLowerCase()).toContain('kestrel')
  // Inside a tab and a place.
  await tab(page, 'Images').click()
  await expect(cards(page)).toHaveCount(1)
  await expect(cards(page).first()).toContainText('kestrel-delivery-times.png')
  await tab(page, 'All').click()
  await places(page).getByRole('button', { name: /^Uploaded by the team/ }).click()
  await expect(cards(page)).toHaveCount(2)
  await box.fill('zzzz')
  await expect(page.getByText('No files match "zzzz".')).toBeVisible()
  await expect(cards(page)).toHaveCount(0)
  await page.getByRole('button', { name: 'Clear search' }).click()
  await expect(cards(page).first()).toBeVisible()
})

test('Masonry, grid and list show the same files; list has name, type, place, size and date', async ({ page }) => {
  await start(page)
  await expect(view(page, 'Masonry')).toHaveAttribute('aria-checked', 'true')
  const n = await cards(page).count()
  await shot(page, 'library-masonry')
  await view(page, 'Grid').click()
  await expect(view(page, 'Grid')).toHaveAttribute('aria-checked', 'true')
  // The picked look keys off data-state; a tooltip on the option once overwrote it while aria-checked stayed right.
  // Hover so the tooltip is really open when the state is read (a click closes it until the pointer leaves and comes back).
  await page.mouse.move(0, 0)
  await view(page, 'Grid').hover()
  await expect(page.getByRole('tooltip', { name: 'Grid' })).toBeVisible()
  await expect(view(page, 'Grid')).toHaveAttribute('data-state', 'on')
  await expect(view(page, 'Masonry')).toHaveAttribute('data-state', 'off')
  await expect(cards(page)).toHaveCount(n)
  // Grid tiles are even: every preview frame has the same height.
  const heights = await page.getByRole('list', { name: 'Files' }).getByRole('listitem').evaluateAll(els => els.slice(0, 12).map(e => Math.round(e.getBoundingClientRect().height)))
  expect(new Set(heights).size, `grid tiles differ: ${heights}`).toBe(1)
  await shot(page, 'library-grid')
  await view(page, 'List').click()
  await expect(cards(page)).toHaveCount(n)
  for (const h of ['Name', 'Type', 'Place', 'Size', 'Date']) await expect(page.getByText(h, { exact: true }).first()).toBeVisible()
  const row = cards(page).filter({ hasText: 'amazon-fee-reimbursement-case.pdf' })
  await expect(row).toContainText('PDF')
  await expect(row).toContainText('Approval: Ask Dana to claim $1,240 from Amazon')
  await expect(row).toContainText('102 KB')
  await expect(row).toContainText('6:06 AM')
  await shot(page, 'library-list')
})

test('Opening a file shows the viewer, and its link goes back to the chat, routine or approval', async ({ page }) => {
  await start(page)
  const open = async (name: string) => { await cards(page).filter({ hasText: name }).first().click(); return page.getByRole('dialog', { name: `File: ${name}` }) }
  const close = async (v: ReturnType<Page['getByRole']>) => { await v.getByRole('button', { name: 'Close' }).click(); await expect(v).toHaveCount(0) }

  // A chat file: details, then the link to the chat.
  let v = await open('stuck-orders-over-3-days.csv')
  await expect(v).toContainText('CSV spreadsheet')
  await expect(v).toContainText('312 B')
  await expect(v).toContainText('7:43 AM')
  await expect(v).toContainText('Inhouse agent')
  await expect(v).toContainText('Chat: Stuck orders over 3 days')
  await expect(v.getByText('#4807')).toBeVisible()
  await v.getByRole('button', { name: 'Open the chat →' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByText('3 orders · $556').first()).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Stuck orders over 3 days' })).toHaveAttribute('aria-current', 'page')

  // A drafted document: first page in the viewer, link opens the approval panel.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Library' }).click()
  v = await open('PO-1188-ridge-30l-kestrel.pdf')
  await expect(v).toContainText('PDF document')
  await expect(v).toContainText('Today: Ridge 30L Pack runs out in 9 days')
  await expect(v.getByText('$9,600').first()).toBeVisible()
  await shot(page, 'library-viewer-document')
  await v.getByRole('button', { name: 'Open the approval →' }).click()
  // The reorder is a finding (#726): its window has the suggestion, no draft to approve.
  await expect(page.getByRole('dialog')).toContainText('Your Inhouse agent suggests')
  await page.keyboard.press('Escape')

  // Routine link.
  v = await open('weekly-ops-report-week-46.pdf')
  await v.getByRole('button', { name: 'Open Routines →' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Routines')
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Library' }).click()

  // An image, a video and an upload (no link back).
  v = await open('damaged-return-4812.jpg')
  await expect(v.getByRole('img', { name: 'damaged-return-4812.jpg' })).toBeVisible()
  await expect(v).toContainText('Leo Park')
  await expect(v.getByRole('button', { name: /^Open / })).toHaveCount(0)
  await shot(page, 'library-viewer-image')
  await v.getByRole('button', { name: 'Download' }).click()
  await expect(page.getByRole('status').filter({ hasText: "Download isn't connected in this demo." })).toBeVisible()
  await close(v)
  v = await open('packing-bench-walkthrough.mp4')
  await expect(v).toContainText('0:00 / 1:36')
  await shot(page, 'library-viewer-video')
  await page.keyboard.press('Escape')
  await expect(v).toHaveCount(0)
})

test('Select, Delete (asks first) and Undo, and the delete survives a reload', async ({ page }) => {
  await start(page)
  const total = await countOf(page, 'All')
  await page.getByRole('button', { name: 'Select', exact: true }).click()
  const bar = page.getByRole('toolbar', { name: 'Selected files' })
  await expect(bar).toContainText('Select files')
  await expect(bar.getByRole('button', { name: 'Delete' })).toBeDisabled()
  await cards(page).filter({ hasText: 'amazon-payout-check.csv' }).click()
  await cards(page).filter({ hasText: 'restock-returns.py' }).click()
  await cards(page).filter({ hasText: 'damaged-return-4812.jpg' }).click()
  await expect(bar).toContainText('3 selected')
  // The list item holds the file's button; in Select mode that button says whether it's picked.
  await expect(cards(page).filter({ hasText: 'restock-returns.py' }).getByRole('button')).toHaveAttribute('aria-pressed', 'true')
  await shot(page, 'library-select')
  // A click in Select mode picks, it doesn't open.
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // Delete asks first. Cancel keeps everything.
  await bar.getByRole('button', { name: 'Delete' }).click()
  const ask = page.getByRole('dialog', { name: 'Delete files' })
  await expect(ask).toContainText('Delete 3 files?')
  await ask.getByRole('button', { name: 'Cancel' }).click()
  await expect(ask).toHaveCount(0)
  await expect(cards(page)).toHaveCount(total)
  await expect(bar).toContainText('3 selected')

  await bar.getByRole('button', { name: 'Delete' }).click()
  await page.getByRole('dialog', { name: 'Delete files' }).getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(cards(page)).toHaveCount(total - 3)
  await expect(tab(page, 'All')).toHaveText(`All ${total - 3}`)
  await expect(places(page).getByRole('button', { name: /^All files/ })).toContainText(String(total - 3))
  await expect(bar).toHaveCount(0)
  const toast = page.getByRole('status').filter({ hasText: 'Deleted 3 files' })
  await expect(toast).toBeVisible()
  await shot(page, 'library-deleted')
  await toast.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(cards(page)).toHaveCount(total)
  await expect(cards(page).filter({ hasText: 'restock-returns.py' })).toHaveCount(1)

  // Delete one again and reload: it stays deleted until Reset demo.
  await page.getByRole('button', { name: 'Select', exact: true }).click()
  await cards(page).filter({ hasText: 'team-calendar-nov.ics' }).click()
  await page.getByRole('toolbar', { name: 'Selected files' }).getByRole('button', { name: 'Delete' }).click()
  await page.getByRole('dialog', { name: 'Delete files' }).getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByText('Deleted 1 file').first()).toBeVisible()
  await page.reload()
  await expect(cards(page)).toHaveCount(total - 1)
  await page.getByRole('button', { name: /Demo switches/ }).click()
  await page.getByRole('button', { name: 'Reset demo' }).click()
  await page.getByRole('button', { name: 'Close demo switches' }).click()
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Library' }).click()
  await expect(cards(page)).toHaveCount(total)
})
