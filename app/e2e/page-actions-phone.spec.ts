// Page actions on a phone (390 px, PR 6): the Usage breakdown stacks so nothing is cut off, and small controls get a 44px hit area.
import { expect, test, type Fx } from './support/fx.js'
import type { Locator, Page } from '@playwright/test'

async function start(page: Page, fx: Fx, hash: string) {
  await fx.seed({ demo: { ambient: 'Always', animateMark: true } })
  await page.goto('/?demo' + hash)
}

async function noSidewaysScroll(page: Page) {
  // Polled: right after a resize or a navigation the layout may not have settled yet. A real overflow still fails.
  await expect.poll(() => page.evaluate(() => Math.max(...[document.documentElement, document.querySelector('main')!].map(e => e.scrollWidth - e.clientWidth))),
    { message: 'horizontal overflow in px (page or main)' }).toBeLessThanOrEqual(1)
}

/**
 * The clickable box of a control: its own box joined with its ::after hit area. The pseudo-element counts only with a
 * real width and height, measured from its computed position and size (an ::after with no horizontal inset is 0 px wide
 * and takes no taps).
 */
const hitBox = (el: Locator) => el.evaluate(e => {
  const r = e.getBoundingClientRect()
  const a = getComputedStyle(e, '::after')
  const w = parseFloat(a.width), h = parseFloat(a.height)
  if (a.position !== 'absolute' || !(w > 0) || !(h > 0)) return { w: r.width, h: r.height }
  // left and top are from the control's padding box (the border is a pixel at most here), then moved by any translate.
  const m = new DOMMatrixReadOnly(a.transform === 'none' ? undefined : a.transform)
  const left = parseFloat(a.left) + m.m41, top = parseFloat(a.top) + m.m42
  return { w: Math.max(r.width, left + w) - Math.min(0, left), h: Math.max(r.height, top + h) - Math.min(0, top) }
})
const atLeast44 = async (el: Locator) => {
  const b = await hitBox(el)
  expect(b.w, 'hit area width').toBeGreaterThanOrEqual(44)
  expect(b.h, 'hit area height').toBeGreaterThanOrEqual(44)
}

test('Phone: Usage breakdown rows stack inside 390 px in every tab, with cost, share and conversations shown', async ({ fx, page }) => {
  await start(page, fx, '#/usage')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Usage')
  for (const tab of ['Person', 'Job', 'Model', 'Tool']) {
    await page.getByRole('radiogroup', { name: 'Break down by' }).getByRole('radio', { name: tab, exact: true }).click()
    const rows = page.locator('[data-usage-row]')
    expect(await rows.count()).toBeGreaterThan(0)
    for (const row of await rows.all()) {
      const box = (await row.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(390)
      await expect(row).toContainText(/\$\d+\.\d\d/)
      await expect(row).toContainText(/\d+%/)
      await expect(row).toContainText(/\d+ conversations?/)
      // Nothing in the row runs past its edge.
      expect(await row.evaluate(e => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1)
    }
    // The desktop table's column heads are gone.
    await expect(page.getByText('Share', { exact: true })).toHaveCount(0)
  }
  await noSidewaysScroll(page)
  await page.screenshot({ path: test.info().outputPath('phone-usage-breakdown.png'), fullPage: true })
})

test('Phone: Approvals and Today small controls have a 44px hit area', async ({ fx, page }) => {
  await start(page, fx, '#/approvals')
  await expect(page.getByRole('heading', { level: 2, name: /^Waiting for you/ })).toBeVisible()
  // A phone has no sort: the header holds Approve all low-risk alone, and each card's "···" is a full tap area.
  await expect(page.getByRole('combobox', { name: /^Sort drafts/ })).toHaveCount(0)
  for (const el of [page.getByRole('button', { name: 'Approve all low-risk' }), page.getByRole('button', { name: /^More actions for/ }).first()]) await atLeast44(el)
  await noSidewaysScroll(page)
  await page.screenshot({ path: test.info().outputPath('phone-approvals-actions.png'), fullPage: true })

  await page.goto('/?demo#/today')
  const more = page.getByRole('article').first().getByRole('button', { name: /^More actions for/ })
  await atLeast44(more)
  await more.click()
  await expect(page.getByRole('menu', { name: 'Card actions' })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('phone-today-card-menu.png') })
})

test('Phone: the Library place chips and the Select bar\'s Download and Delete have a 44px hit area', async ({ fx, page }) => {
  await start(page, fx, '#/library')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('All files')
  const chips = page.getByRole('navigation', { name: 'Library places' }).getByRole('button')
  expect(await chips.count()).toBeGreaterThan(1)
  for (const chip of await chips.all()) await atLeast44(chip)
  // The tap just above a chip's top edge (inside the hit area, outside the chip) still picks it.
  const last = chips.last()
  await last.scrollIntoViewIfNeeded()
  const box = (await last.boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y - 4)
  await expect(last).toHaveAttribute('aria-pressed', 'true')
  await chips.first().click()

  await page.getByRole('button', { name: 'Select', exact: true }).click()
  await page.getByRole('list', { name: 'Files' }).getByRole('listitem').first().getByRole('button').first().click()
  const bar = page.getByRole('toolbar', { name: 'Selected files' })
  for (const name of ['Download', 'Delete']) await atLeast44(bar.getByRole('button', { name }))
  await noSidewaysScroll(page)
  await page.screenshot({ path: test.info().outputPath('phone-library-select-bar.png') })
})
