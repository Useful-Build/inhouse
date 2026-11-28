// PR 7, Pages and windows, at 1440: pause a tool and see its Read and Draft change; every page on First day and while
// Loading shows a real state; a Run now lands in a routine's Last runs with its result. The phone twin is
// pages-polish-phone.spec.ts, and the checks are in pages-polish-checks.ts.
import { expect, test } from './support/fx.js'
import { pagesPolish } from './pages-polish-checks.js'

pagesPolish(test, 'desktop')

for (const width of [1440, 1024]) {
  test(`Models (desktop ${width}): one "How hard it thinks" caption, over the first picker`, async ({ page, fx }) => {
    await page.setViewportSize({ width, height: 900 })
    await fx.seed({ once: false })
    await page.goto('/?demo#/settings/team-modes')
    // One caption shows: above the picker column on a wide card, above the first picker when rows wrap.
    const visible = page.getByText('How hard it thinks', { exact: true }).filter({ visible: true })
    await expect(visible).toHaveCount(1)
    const cap = (await visible.boundingBox())!
    const picker = (await page.getByRole('combobox', { name: /^How hard it thinks: / }).first().boundingBox())!
    expect(cap.x < picker.x + picker.width && picker.x < cap.x + cap.width).toBe(true)
    expect(cap.y + cap.height).toBeLessThanOrEqual(picker.y)
  })
}
