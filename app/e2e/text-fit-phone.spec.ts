// Phone: the composer's placeholder fits the box at 390 and 360 px.
import { expect, test } from './csp.js'
import { atRest } from './states.js'

const out = process.env.VERIFY_DIR ?? 'e2e-artifacts'

for (const width of [390, 360]) {
  test(`Phone ${width}: the Today composer placeholder is not cut`, async ({ page }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem('e2e-seeded')) return
      localStorage.clear()
      localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: 'Act', scenario: 'Normal', ambient: 'Always', animateMark: false }))
      sessionStorage.setItem('e2e-seeded', '1')
    })
    await page.setViewportSize({ width, height: 844 })
    await page.goto('/?demo#/today')
    const input = page.getByRole('textbox', { name: 'Ask your Inhouse agent' })
    await expect(input).toHaveAttribute('placeholder', 'Ask about orders, stock or numbers')
    const r = await input.evaluate((el: HTMLInputElement) => {
      const cs = getComputedStyle(el)
      const g = document.createElement('canvas').getContext('2d')!
      g.font = cs.font
      return { text: g.measureText(el.placeholder).width, box: el.clientWidth }
    })
    expect(r.text, `placeholder ${Math.round(r.text)}px in a ${r.box}px box`).toBeLessThanOrEqual(r.box)
    await atRest(page)
    await page.screenshot({ path: `${out}/composer-${width}.png` })
  })
}

// In Run, the status pill must not squeeze an open chat's title on a phone.
for (const width of [390, 360]) {
  test(`Phone ${width}: in Run, an open chat's title keeps its room beside the pill`, async ({ page }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem('e2e-seeded')) return
      localStorage.clear()
      localStorage.setItem('inhouse.demo.switches.v1', JSON.stringify({ stage: 'Run', scenario: 'Normal', ambient: 'Always', animateMark: false }))
      sessionStorage.setItem('e2e-seeded', '1')
    })
    await page.setViewportSize({ width, height: 844 })
    await page.goto('/?demo#/today')
    const pill = page.getByRole('status', { name: 'Inhouse agent is running' })
    await expect(pill).toBeVisible()
    await page.goto('/?demo#/chats/friday')
    await expect(pill).toHaveCount(0)
    const title = page.locator('header span', { hasText: "What to feature" }).first()
    await expect(title).toBeVisible()
    const cut = await title.evaluate(el => el.scrollWidth > el.clientWidth + 1)
    expect(cut).toBe(false)
    await page.screenshot({ path: `${out}/r5-run-chat-title-${width}.png` })
  })
}
