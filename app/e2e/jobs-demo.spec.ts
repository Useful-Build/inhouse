// Stage 1 PR 2 in the demo (desktop, light & dark, axe, screenshots):
//  - J1: typing a long task runs as a long job with carry-on note and finishes on the demo clock;
//  - J2 & J5: `catalog-audit` shows the running job row with 2 helpers, answers a follow-up while staying running,
//    then Cancel job ends it, moves focus to "Long job stopped", and adds an unread bell notice;
//  - J3 & J4: `seasonal-restock` shows "Ran for 2 h 14 min." and two carry-on notes; `ad-spend-audit` shows
//    the stopped-at-budget card; the bell lists "A long job finished" and "A long job stopped";
//  - J6: trace opens with "Asking a helper" and nested helper sub-steps;
//  - J7 & J8: `competitor-prices` shows web steps and Sources, and flipping Search the web / Websites it may open
//    in Settings changes the demo agent's live answer.
// Phone: jobs-demo-phone.spec.ts.
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, fxFor, test, type Theme } from './support/fx.js'
import { openTraceFrom } from './support/steps.js'

async function start(page: Page, hash: string, theme: Theme = 'light', settings?: Record<string, string>) {
  await fxFor(page, undefined).seedSaved({ stage: 'Act', scenario: 'Normal', theme }, settings ? { settings } : {})
  await page.goto('/?demo' + hash)
}

const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.timeline instanceof DocumentTimeline && a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished)))
const shot = async (page: Page, name: string, fullPage = false) => {
  await settled(page)
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage })
}
async function axeClean(page: Page, name: string) {
  await settled(page)
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  expect(violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`), name).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${name} scrolls sideways`).toBe(true)
}

for (const theme of ['light', 'dark'] as const) {
  test(`running, finished (2 h 14 min), stopped at budget, and web job chats render cleanly (${theme})`, async ({ page }) => {
    await start(page, '#/chats/catalog-audit', theme)
    const running = page.locator('[data-job-status="running"]')
    await expect(running.getByRole('heading', { name: 'Working on a long job' })).toBeVisible()
    await expect(running).toContainText('Checking variant margins on Shopify · 2 helpers working')
    await expect(running.getByRole('button', { name: 'Cancel job' })).toBeVisible()
    await shot(page, `demo-job-running-${theme}`)
    await axeClean(page, `demo job running ${theme}`)

    await page.goto('/?demo#/chats/seasonal-restock')
    const finished = page.locator('[data-job-status="ended"]')
    await expect(finished.getByRole('heading', { name: 'Long job finished' })).toBeVisible()
    await expect(finished).toContainText('Ran for 2 h 14 min.')
    await expect(page.getByText('Your Inhouse agent carried on with this task by itself.')).toHaveCount(2)
    await shot(page, `demo-job-finished-${theme}`)
    await axeClean(page, `demo job finished ${theme}`)

    await page.goto('/?demo#/chats/ad-spend-audit')
    const budget = page.locator('[data-job-status="ended"]')
    await expect(budget.getByRole('heading', { name: 'Long job stopped' })).toBeVisible()
    await expect(budget).toContainText('It reached the most one job may spend.')
    await expect(budget).toContainText('Ran for 47 min.')
    await shot(page, `demo-job-budget-${theme}`)
    await axeClean(page, `demo job budget ${theme}`)
  })
}

test('follow-up during running job keeps it going, Cancel focuses stopped card and notifies bell', async ({ page }) => {
  await start(page, '#/chats/catalog-audit')
  const running = page.locator('[data-job-status="running"]')
  await expect(running).toBeVisible()

  await page.getByRole('textbox', { name: 'Message Inhouse' }).fill('Which margin is lowest so far?')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('log', { name: 'Conversation' })).toContainText('33% net margin', { timeout: 15_000 })
  // Running job row stays active below the composer after the follow-up answer.
  await expect(running).toContainText('Checking variant margins on Shopify · 2 helpers working')

  await running.getByRole('button', { name: 'Cancel job' }).click()
  const stopped = page.locator('[data-job-status="ended"]')
  const heading = stopped.getByRole('heading', { name: 'Long job stopped' })
  await expect(heading).toBeVisible()
  await expect(heading).toBeFocused()
  await expect(stopped).toContainText('It was stopped before it finished.')

  // Bell shows the two seeded job notices plus the live cancelled-job notice.
  await page.getByRole('button', { name: /^Notifications/ }).click()
  const bell = page.getByRole('dialog', { name: 'Notifications' })
  await expect(bell).toContainText('A long job stopped. It was stopped before it finished.')
  await expect(bell).toContainText('A long job finished')
  await expect(bell).toContainText('A long job stopped')
})

test('helper trace steps show Asking a helper and nested helper steps (J6)', async ({ page }) => {
  await start(page, '#/chats/catalog-audit')
  await openTraceFrom(page.locator('main').locator('[data-steps] > button').last())
  const dialog = page.getByRole('dialog', { name: /What your Inhouse agent did/ })
  await expect(dialog).toContainText('Asking a helper')
  await expect(dialog).toContainText('Analyst · size-level exchange cost table')
})

test('typed long task runs on the demo clock as a long job with carry-on note (J1)', async ({ page }) => {
  await start(page, '#/today')
  await page.getByRole('textbox', { name: 'Ask Inhouse' }).fill('Run a full catalog audit across every SKU')
  await page.keyboard.press('Enter')
  const running = page.locator('[data-job-status="running"]')
  await expect(running).toBeVisible({ timeout: 15_000 })
  await expect(running).toContainText('2 helpers working')
  const finished = page.locator('[data-job-status="ended"]')
  await expect(finished.getByRole('heading', { name: 'Long job finished' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('log', { name: 'Conversation' })).toContainText('Your Inhouse agent carried on with this task by itself.')
})

test('competitor prices shows web steps and sources, and web switches change live answers (J7, J8)', async ({ page }) => {
  await start(page, '#/chats/competitor-prices', 'light', { 't:webfetch': 'trailgear.example.test\npeaksupply.example.test' })
  const log = page.getByRole('log', { name: 'Conversation' })
  await expect(log.getByRole('link', { name: 'TrailGear bottle page' })).toHaveAttribute('href', 'https://trailgear.example.test/bottles')
  await log.getByRole('button', { name: '3 sources' }).click()
  await expect(log).toContainText('trailgear.example.test/bottles')
  await openTraceFrom(page.locator('main').locator('[data-steps] > button').last())
  const trace = page.getByRole('dialog', { name: /What your Inhouse agent did/ })
  await expect(trace).toContainText('Searching the web')
  await expect(trace).toContainText('Reading a web page')
  await page.keyboard.press('Escape')

  // Off by default: asking for a web search tells you Search the web is turned off.
  await page.evaluate(() => { location.hash = '#/today' })
  await page.getByRole('textbox', { name: 'Ask Inhouse' }).fill('Search the web for competitor prices on bottles')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('log', { name: 'Conversation' })).toContainText('Search the web is turned off in Settings', { timeout: 15_000 })

  // Turn Search the web ON in Settings > Inhouse agent, keep allowed websites, ask again -> live web links.
  await page.evaluate(() => { location.hash = '#/settings/team-agent' })
  const sw = page.getByRole('switch', { name: 'Search the web', exact: true })
  await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', 'true')
  await page.evaluate(() => { location.hash = '#/today' })
  await page.getByRole('textbox', { name: 'Ask Inhouse' }).fill('Search the web for competitor prices on bottles')
  await page.keyboard.press('Enter')
  const liveLog = page.getByRole('log', { name: 'Conversation' })
  await expect(liveLog.getByRole('link', { name: 'trailgear.example.test' })).toHaveAttribute('href', 'https://trailgear.example.test/', { timeout: 15_000 })
})
