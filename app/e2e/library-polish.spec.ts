// PR 6, the Library: search with no results and Clear, counts that follow the search, place and type together, a
// file's own link (Back closes it, a link opens it), names that show whole at 390, 768 and 1440, and the first-day and
// loading states. Screenshots go to the report.
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

async function start(page: Page, hash = '#/library', width = 1440, scenario = 'Normal', theme = 'light') {
  await page.setViewportSize({ width, height: width < 800 ? 844 : 900 })
  await page.addInitScript(([sc, th]) => {
    if (sessionStorage.getItem('e2e-seeded')) return
    localStorage.clear()
    localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: 'Act', scenario: sc, ambient: 'Off', animateMark: false }))
    localStorage.setItem('inhouse.theme', th)
    sessionStorage.setItem('e2e-seeded', '1')
  }, [scenario, theme])
  await page.goto('/?demo' + hash)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('All files')
}

const shot = async (page: Page, name: string) => { await page.waitForTimeout(400); await page.screenshot({ path: test.info().outputPath(`${name}.png`) }) }
const places = (page: Page) => page.getByRole('navigation', { name: 'Library places' })
const items = (page: Page) => page.getByRole('list', { name: 'Files' }).getByRole('listitem')
const tab = (page: Page, name: string) => page.getByRole('radiogroup', { name: 'File type' }).getByRole('radio', { name: new RegExp(`^${name} \\d+$`) })
const place = (page: Page, name: string) => places(page).getByRole('button', { name: new RegExp(`^${name} \\d+$`) })
const num = async (el: ReturnType<Page['locator']>) => Number((await el.innerText()).replace(/\D/g, ''))
const hash = (page: Page) => new URL(page.url()).hash
const box = (page: Page) => page.getByRole('searchbox', { name: 'Search library' })
const noSideways = (page: Page) => page.evaluate(() => [document.documentElement, document.querySelector('main')!].every(e => e.scrollWidth - e.clientWidth <= 1))

test('Search with no results offers Clear, and every count follows the search', async ({ page }) => {
  await start(page)
  const total = await num(tab(page, 'All'))
  expect(await num(place(page, 'All files'))).toBe(total)

  // A search with matches: the places add up to the types and to the list.
  await box(page).fill('kestrel')
  const n = await items(page).count()
  expect(n).toBeGreaterThanOrEqual(3)
  expect(n).toBeLessThan(total)
  expect(await num(tab(page, 'All'))).toBe(n)
  expect(await num(place(page, 'All files'))).toBe(n)
  let sum = 0
  for (const p of ['Chats', 'Routines', 'Approvals', 'Uploaded by the team']) sum += await num(place(page, p))
  expect(sum, 'the places count what the search finds').toBe(n)

  // Nothing found: a message, zero everywhere and a Clear button.
  await box(page).fill('zzzz')
  await expect(page.getByText('No files match "zzzz".')).toBeVisible()
  await expect(items(page)).toHaveCount(0)
  expect(await num(tab(page, 'All'))).toBe(0)
  expect(await num(place(page, 'All files'))).toBe(0)
  expect(await num(place(page, 'Chats'))).toBe(0)
  await shot(page, 'library-no-results')
  await page.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(box(page)).toHaveValue('')
  await expect(page.getByText(/No files match/)).toHaveCount(0)
  await expect(items(page)).toHaveCount(total)
  expect(await num(place(page, 'All files'))).toBe(total)
})

test('Place and type work together, with the search on', async ({ page }) => {
  await start(page)
  await box(page).fill('report')
  await place(page, 'Routines').click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Routines')
  const docs = await num(tab(page, 'Documents'))
  expect(docs).toBeGreaterThan(0)
  await tab(page, 'Documents').click()
  await expect(items(page)).toHaveCount(docs)
  for (const t of await items(page).allInnerTexts()) expect(t.toLowerCase()).toContain('report')
  // A type with nothing in this place says so.
  await tab(page, 'Images').click()
  await expect(items(page)).toHaveCount(0)
  await expect(page.getByText('No files match "report".')).toBeVisible()
  await place(page, 'All files').click()
  await box(page).fill('')
  await tab(page, 'All').click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('All files')
  await expect(items(page).first()).toBeVisible()
})

test('An open file has its own link: Back closes it, stepping adds no entries, a link opens it', async ({ page }) => {
  await start(page)
  const total = await items(page).count()
  await items(page).filter({ hasText: 'weekly-ops-report-week-46.pdf' }).first().click()
  const viewer = page.getByRole('dialog', { name: /^File: / })
  await expect(viewer).toBeVisible()
  expect(hash(page)).toMatch(/^#\/library\/.+/)
  const opened = hash(page)

  // Back closes it and leaves the list.
  await page.goBack()
  await expect(viewer).toHaveCount(0)
  expect(hash(page)).toBe('#/library')
  await expect(items(page)).toHaveCount(total)
  // Forward opens the same file again.
  await page.goForward()
  await expect(viewer).toBeVisible()
  expect(hash(page)).toBe(opened)

  // Stepping to the next file changes the link but not the history: one Back still closes the viewer.
  const first = await viewer.getAttribute('aria-label')
  await viewer.getByRole('button', { name: 'Next file' }).click()
  await expect(viewer).not.toHaveAttribute('aria-label', first!)
  expect(hash(page)).not.toBe(opened)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowLeft')
  await page.goBack()
  await expect(viewer).toHaveCount(0)
  expect(hash(page)).toBe('#/library')

  // A link opens the file straight away, on a fresh load (a different query makes it a real navigation, not a hash move).
  // Close on it lands on the list, and the page stays put.
  await page.goto(`/?demo&fresh=1${opened}`)
  await expect(page.getByRole('dialog', { name: 'File: weekly-ops-report-week-46.pdf' })).toBeVisible()
  // A reload on the file's link opens it again.
  await page.reload()
  await expect(page.getByRole('dialog', { name: 'File: weekly-ops-report-week-46.pdf' })).toBeVisible()
  expect(hash(page)).toBe(opened)
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(hash(page)).toBe('#/library')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('All files')

  // A link to a file that isn't there says so and lands on the list.
  await page.evaluate(() => { location.hash = '#/library/no-such-file' })
  await expect(page.getByRole('status').filter({ hasText: "That file isn't available" })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(hash(page)).toBe('#/library')

  // Pressing Close twice at once (a double click, a held Escape) closes the viewer and goes back only one step.
  await page.evaluate(() => { location.hash = '#/today' })
  await page.evaluate(() => { location.hash = '#/library' })
  await items(page).first().click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('All files')
  expect(hash(page)).toBe('#/library')
})

test('The viewer\'s link to a chat, Routines or an approval leaves no dead history entry', async ({ page }) => {
  await start(page)
  const today = async () => { await page.evaluate(() => { location.hash = '#/today' }); await page.evaluate(() => { location.hash = '#/library' }) }
  await today()

  // A chat: the chat opens, the first Back lands on the Library's list, the second on the page before it.
  await items(page).filter({ hasText: 'stuck-orders-over-3-days.csv' }).first().click()
  await page.getByRole('dialog').getByRole('button', { name: 'Open the chat →' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByText('3 orders · $556').first()).toBeVisible()
  expect(hash(page)).toMatch(/^#\/chats\//)
  await page.goBack()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('All files')
  expect(hash(page)).toBe('#/library')
  await page.goBack()
  await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('All files')
  expect(hash(page)).toBe('#/today')

  // Routines: the same two steps.
  await page.goForward()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('All files')
  await items(page).filter({ hasText: 'weekly-ops-report-week-46.pdf' }).first().click()
  await page.getByRole('dialog').getByRole('button', { name: 'Open Routines →' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Routines')
  expect(hash(page)).toBe('#/routines')
  await page.goBack()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('All files')
  expect(hash(page)).toBe('#/library')
  await page.goBack()
  expect(hash(page)).toBe('#/today')

  // An approval opens over the list: the viewer closes, the approval panel is up, and the first Back leaves the Library.
  await page.evaluate(() => { location.hash = '#/library' })
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('All files')
  await items(page).filter({ hasText: 'PO-1188-ridge-30l-kestrel.pdf' }).first().click()
  await page.getByRole('dialog').getByRole('button', { name: 'Open the approval →' }).click()
  await expect(page.getByRole('button', { name: 'Approve and send to Kestrel' })).toBeVisible()
  await expect(page.getByRole('dialog', { name: /^File: / })).toHaveCount(0)
  expect(hash(page)).toBe('#/library')
  await page.keyboard.press('Escape')
  await page.goBack()
  expect(hash(page)).toBe('#/today')
})

/**
 * Every file name and details line shows whole: nothing is cut sideways (an ellipsis) or vertically (a clamp), the
 * list's place column included (it wraps to a second line rather than cutting).
 */
async function nothingCut(page: Page, label: string) {
  await page.evaluate(() => document.fonts.ready)
  const cut = await page.getByRole('list', { name: 'Files' }).evaluate(list => {
    const out: string[] = []
    for (const el of list.querySelectorAll<HTMLElement>('.font-strong, .text-xs, .ellipsis')) {
      if (!el.offsetParent) continue
      // Preview art (a document page drawn small) and icon glyphs are decoration, cut on purpose.
      if (el.closest('[aria-hidden="true"]')) continue
      // Visible text: the element's text without its aria-hidden icons.
      const copy = el.cloneNode(true) as HTMLElement
      copy.querySelectorAll('[aria-hidden="true"]').forEach(n => n.remove())
      const text = copy.textContent?.trim()
      if (!text) continue
      if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) out.push(text)
    }
    return out
  })
  expect(cut, `${label}: cut text`).toEqual([])
}

for (const width of [1440, 768, 390]) {
  test(`Open and page through files at ${width}: names show whole, the viewer title too`, async ({ page }) => {
    await start(page, '#/library', width)
    const phone = width < 761
    // The places sit beside the files on a wide screen and above them below 1024.
    const nav = (await places(page).boundingBox())!
    const h1 = (await page.getByRole('heading', { level: 1 }).boundingBox())!
    if (width >= 1024) expect(nav.x + nav.width, 'places at the left').toBeLessThanOrEqual(h1.x + 1)
    else expect(nav.y + nav.height, 'places above the files').toBeLessThanOrEqual(h1.y + 1)
    expect(await noSideways(page)).toBe(true)

    // The selected place looks like the selected row of the side menu.
    if (!phone) {
      const sideItem = page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Library/ })
      await page.mouse.move(0, 0)
      await page.waitForTimeout(300) // the fill eases in
      const bg = (el: ReturnType<Page['locator']>) => el.evaluate(e => getComputedStyle(e).backgroundColor)
      expect(await bg(place(page, 'All files'))).toBe(await bg(sideItem))
    }

    // A list: whole names, however narrow. Phone: one list, no pictures.
    if (!phone) await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: 'List' }).click()
    await expect(items(page).first()).toBeVisible()
    await nothingCut(page, `list at ${width}`)
    if (phone) await expect(items(page).locator('img')).toHaveCount(0)
    // The longest names, by name.
    for (const name of ['amazon-fee-reimbursement-case.pdf', 'PO-1187-kestrel-summit-fleece.pdf']) {
      const n = page.getByRole('list', { name: 'Files' }).getByText(name, { exact: true })
      await n.scrollIntoViewIfNeeded()
      expect(await n.evaluate(e => e.scrollHeight <= e.clientHeight + 1 && e.scrollWidth <= e.clientWidth + 1), `${name} at ${width}`).toBe(true)
    }
    await shot(page, `library-list-${width}`)

    // Grid and masonry on a desktop: the name and the details line show whole in the cards too.
    if (!phone) {
      for (const v of ['Grid', 'Masonry']) {
        await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: v }).click()
        await expect(items(page).first()).toBeVisible()
        await nothingCut(page, `${v} at ${width}`)
        const x = items(page).filter({ hasText: 'ridge-30l-reorder-options.xlsx' }).first()
        // The "from" line shows whole: its text is all there and none of it is clamped away.
        const from = x.getByText('Chat: Ridge 30L reorder quantity', { exact: true })
        await expect(from).toHaveText('Chat: Ridge 30L reorder quantity')
        expect(await from.evaluate(e => e.scrollHeight <= e.clientHeight + 1 && e.scrollWidth <= e.clientWidth + 1), `from line in ${v} at ${width}`).toBe(true)
        await x.scrollIntoViewIfNeeded()
        await shot(page, `library-${v.toLowerCase()}-${width}`)
      }
      await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: 'List' }).click()
    }

    // Open the first file and page through four: the title shows whole, the link follows, and the first has no Previous.
    await items(page).first().click()
    const viewer = page.getByRole('dialog', { name: /^File: / })
    await expect(viewer).toBeVisible()
    await expect(viewer.getByRole('button', { name: 'Previous file' })).toBeDisabled()
    const seen = new Set<string>()
    for (let i = 0; i < 4; i++) {
      const label = (await viewer.getAttribute('aria-label'))!
      seen.add(label)
      const name = label.replace(/^File: /, '')
      const title = viewer.getByText(name, { exact: true }).first()
      expect(await title.evaluate(e => e.scrollHeight <= e.clientHeight + 1 && e.scrollWidth <= e.clientWidth + 1), `title of ${name} at ${width}`).toBe(true)
      const b = (await viewer.boundingBox())!
      expect(b.x).toBeGreaterThanOrEqual(0)
      expect(b.x + b.width).toBeLessThanOrEqual(width)
      if (i === 0) await shot(page, `library-viewer-${width}`)
      await viewer.getByRole('button', { name: 'Next file' }).click()
      await expect(viewer).not.toHaveAttribute('aria-label', label)
    }
    expect(seen.size).toBe(4)
    expect(hash(page)).toMatch(/^#\/library\/.+/)
    await page.goBack()
    await expect(viewer).toHaveCount(0)
  })
}

test('Phone: a long file name shows whole in the viewer, and a code file scrolls sideways', async ({ page }) => {
  await start(page, '#/library', 390)
  await items(page).filter({ hasText: 'PO-1187-kestrel-summit-fleece.pdf' }).first().click()
  const viewer = page.getByRole('dialog', { name: 'File: PO-1187-kestrel-summit-fleece.pdf' })
  const title = viewer.getByText('PO-1187-kestrel-summit-fleece.pdf', { exact: true }).first()
  await expect(title).toBeVisible()
  expect(await title.evaluate(e => e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1), 'the name is cut').toBe(false)
  await page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)

  // Code keeps its lines: the block scrolls sideways inside itself, the page doesn't.
  await box(page).fill('shipbob-ticket') // a file with a 150 character line
  await items(page).filter({ hasText: 'shipbob-ticket-order-4821.md' }).first().click()
  const code = page.getByRole('dialog', { name: /^File: / }).locator('pre')
  await expect(code).toBeVisible()
  const c = await code.evaluate(e => ({ ws: getComputedStyle(e).whiteSpace, ox: getComputedStyle(e).overflowX }))
  expect(c).toEqual({ ws: 'pre', ox: 'auto' })
  // The long line is wider than the block, and the block scrolls to it.
  expect(await code.evaluate(e => e.scrollWidth > e.clientWidth + 1), 'a long line overflows the block').toBe(true)
  expect(await code.evaluate(e => { e.scrollLeft = 40; return e.scrollLeft }), 'the block scrolls sideways').toBeGreaterThan(0)
  expect(await noSideways(page)).toBe(true)
  await shot(page, 'library-viewer-code-390')
})

test('Dark: previews are dimmed, and light keeps them as they are', async ({ page }) => {
  await start(page, '#/library', 1440, 'Normal', 'dark')
  const filter = () => items(page).filter({ hasText: 'weekly-ops-report-week-46.pdf' }).first().locator('.preview-dim').first().evaluate(e => getComputedStyle(e).filter)
  expect(await filter()).toMatch(/brightness\(0\.8/)
  await shot(page, 'library-masonry-dark')
  await page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: 'Grid' }).click()
  await shot(page, 'library-grid-dark')
  await page.evaluate(() => { localStorage.setItem('inhouse.theme', 'light') })
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('All files')
  expect(await filter()).toMatch(/brightness\(1\)|none/)
})

test('First day shows what the Library is for', async ({ page }) => {
  await start(page, '#/library', 1440, 'First day')
  await expect(page.getByText('No files yet', { exact: true })).toBeVisible()
  await expect(page.locator('[data-file-id]')).toHaveCount(0)
  expect(await num(place(page, 'All files'))).toBe(0)
  await shot(page, 'library-first-day')
})

test('Loading shows placeholders where the files will be, at 1440 and 390', async ({ page }) => {
  await start(page, '#/library', 1440, 'Loading')
  await expect(page.getByRole('status').filter({ hasText: 'Loading files' })).toBeAttached()
  await expect(page.getByText('No files yet', { exact: true })).toHaveCount(0)
  await expect(page.locator('[data-file-id]')).toHaveCount(0)
  await shot(page, 'library-loading')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('status').filter({ hasText: 'Loading files' })).toBeAttached()
  expect(await noSideways(page)).toBe(true)
  await shot(page, 'library-loading-390')
})
