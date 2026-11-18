// PR 7, Pages and windows, at 1440: pause a tool and see its Read and Draft change; every page on First day and while
// Loading shows a real state; a Run now lands in a routine's Last runs with its result. The phone twin is
// pages-polish-phone.spec.ts, and the checks are in pages-polish-checks.ts.
import { expect, test } from '@playwright/test'
import { pagesPolish } from './pages-polish-checks.js'

pagesPolish(test, 'desktop')

for (const width of [1440, 1024]) {
  test(`Models (desktop ${width}): one "How hard it thinks" caption, over the first picker`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.addInitScript(() => {
      localStorage.clear()
      localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: 'Act', scenario: 'Normal', ambient: 'Off', animateMark: false }))
    })
    await page.goto('/?demo#/settings/team-modes')
    const captions = page.getByText('How hard it thinks', { exact: true })
    await expect(captions.first()).toBeVisible()
    const visible = []
    for (const c of await captions.all()) if (await c.isVisible()) visible.push(c)
    expect(visible).toHaveLength(1)
    const cap = (await visible[0].boundingBox())!
    const picker = (await page.getByRole('combobox', { name: /^How hard it thinks: / }).first().boundingBox())!
    expect(cap.x < picker.x + picker.width && picker.x < cap.x + cap.width).toBe(true)
    expect(cap.y + cap.height).toBeLessThanOrEqual(picker.y)
  })
}
