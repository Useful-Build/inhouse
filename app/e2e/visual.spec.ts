// Visual regression: every state in states.ts, light and dark, compared with the committed baselines in
// visual.spec.ts-snapshots/. The visual-desktop (1440x900) and visual-phone (390x844) projects run it.
// Update the baselines on purpose with npm run test:visual:update; the image diff then shows in the PR.
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { openState, STATES, THEMES } from './states.js'

// The app scrolls inside main (and, on desktop, inside the Settings page and the Library file list), not the
// document, so a full-page shot alone stops at the fold. For page states, grow the viewport's height until those
// areas show everything. Widths, and so the layout breakpoints, stay as they are.
async function growToContent(page: Page) {
  const { width } = page.viewportSize()!
  let last = Infinity
  for (let i = 0; i < 4; i++) {
    const extra = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll('main, main *')]
      .filter(e => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.clientHeight >= 200)
      .map(e => e.scrollHeight - e.clientHeight)))
    if (extra <= 1 || extra >= last) break
    last = extra
    await page.setViewportSize({ width, height: page.viewportSize()!.height + extra })
  }
}

for (const theme of THEMES) {
  for (const s of STATES) {
    test(`${theme} · ${s.name}`, async ({ page }) => {
      await openState(page, s, theme)
      if (!s.act) await growToContent(page)
      await expect(page).toHaveScreenshot(`${theme}-${s.name}.png`, { fullPage: true })
    })
  }
}
