// Stage 1 PR 2 in the demo, on a phone (390px): running, finished (2 h 14 min), stopped-at-budget job cards and Cancel,
// in both themes, checked with axe and for horizontal overflow. Desktop: jobs-demo.spec.ts.
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, fxFor, test, type Theme } from './support/fx.js'

async function start(page: Page, hash: string, theme: Theme) {
  await fxFor(page, undefined).seed({ stage: 'Act', scenario: 'Normal', theme })
  await page.goto('/?demo' + hash)
}
const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.timeline instanceof DocumentTimeline && a.effect?.getTiming().iterations !== Infinity).map(a => a.finished)))
async function checked(page: Page, name: string) {
  await settled(page)
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  expect(violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`), name).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${name} scrolls sideways`).toBe(true)
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) })
}

for (const theme of ['light', 'dark'] as const) {
  test(`running, finished and budget-stopped job cards fit a phone cleanly (${theme})`, async ({ page }) => {
    await start(page, '#/chats/catalog-audit', theme)
    const running = page.locator('[data-job-status="running"]')
    await expect(running.getByRole('heading', { name: 'Working on a long job' })).toBeVisible()
    await checked(page, `demo-job-running-phone-${theme}`)

    await page.goto('/?demo#/chats/seasonal-restock')
    const finished = page.locator('[data-job-status="ended"]')
    await expect(finished.getByRole('heading', { name: 'Long job finished' })).toBeVisible()
    await expect(finished).toContainText('Ran for 2 h 14 min.')
    await checked(page, `demo-job-finished-phone-${theme}`)

    await page.goto('/?demo#/chats/catalog-audit')
    await page.locator('[data-job-status="running"]').getByRole('button', { name: 'Cancel job' }).click()
    const stopped = page.locator('[data-job-status="ended"]')
    await expect(stopped.getByRole('heading', { name: 'Long job stopped' })).toBeFocused()
    await checked(page, `demo-job-stopped-phone-${theme}`)
  })
}
