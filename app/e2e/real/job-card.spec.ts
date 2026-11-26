// A long job's row and result card in the chat (Stage 1 M1-D) on the test build, desktop and phone, light and dark. A
// job needs a container turn, which this build has none of, so each test answers route 100 (`GET /api/chats/:id/job`)
// and route 101 (Cancel) itself with Playwright's `page.route`, as routine-last-runs.spec.ts answers route 86: the page,
// the client's reading of the answer and the card are the real ones. The sandbox's e2e/api/jobs.spec.ts proves the
// routes and the job itself; the unit tests (src/screens/chat/job-status.test.ts, job-view.test.ts) prove what shows.
// It would fail if: a running job showed no row or no Cancel; Cancel didn't ask route 101 or didn't turn the row into
// the stopped card; a finished job's card didn't say how it ended, how long it ran and what it cost; or either failed
// axe (WCAG 2.1 A and AA) in light or dark, or scrolled sideways.
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, test } from '../support/test-build/index.js'
import { open, signInAs } from '../support/clients/real.js'
import { createChat } from '../api/chat-kit.ts'
import { actor } from '../api/kit.ts'

const JOB_ID = 'j_Cardaaaaaaaaaaaaaaaaaa'
const ROOT = 't_Rootaaaaaaaaaaaaaaaaa'
const at = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })
const START = Date.UTC(2026, 10, 26, 9, 0)
const job = (chatId: string, o: Record<string, unknown>) => ({
  jobId: JOB_ID, chatId, rootTurnId: ROOT, state: 'running', outcome: null, startedAt: at(START), deadlineAt: at(START + 8 * 3_600_000),
  endedAt: null, progress: null, cost: null, ...o,
})

/** axe on the page as it is, then the same in dark; a named screenshot of each for the run's artifacts. */
async function checkBothThemes(page: Page, name: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    if (scheme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
    await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running' || !(a.timeline instanceof DocumentTimeline) || a.effect?.getTiming().iterations === Infinity))
    const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
    expect(violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`), `${name} ${scheme}`).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${name} ${scheme} scrolls sideways`).toBe(true)
    await page.locator('[data-job-status]').screenshot({ path: test.info().outputPath(`${name}-${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

test('a running job shows its progress with Cancel, and Cancel turns it into the stopped card', async ({ page, context, request }) => {
  const chatId = await createChat(request, actor('memberA'), undefined, 'Count the orders')
  let cancels = 0
  await page.route(`**/api/chats/${chatId}/job`, route => route.fulfill({ json: { job: job(chatId, { progress: { label: 'Reading this year\'s orders', helpers: 2 } }) } }))
  await page.route(`**/api/jobs/${JOB_ID}/cancel`, route => {
    cancels++
    return route.fulfill({ json: { job: job(chatId, { state: 'ended', outcome: 'cancelled', endedAt: at(START + 12 * 60_000), cost: { minor: 140, currency: 'USD' } }) } })
  })
  await signInAs(context, 'dana')
  await open(page, 'dana', `#/chats/${chatId}`)

  const row = page.locator('[data-job-status="running"]')
  await expect(row.getByRole('heading', { name: 'Working on a long job' })).toBeVisible()
  await expect(row).toContainText("Reading this year's orders · 2 helpers working")
  await checkBothThemes(page, 'job-running')

  await row.getByRole('button', { name: 'Cancel' }).click()
  const card = page.locator('[data-job-status="ended"]')
  await expect(card.getByRole('heading', { name: 'Long job stopped' })).toBeVisible()
  await expect(card).toContainText('It was stopped before it finished.')
  await expect(card).toContainText('Ran for 12 min, cost $1.40.')
  expect(cancels).toBe(1)
  await expect(row).toHaveCount(0)
})

test('a finished job shows its result card: how it ended, how long it ran and what it cost', async ({ page, context, request }) => {
  const chatId = await createChat(request, actor('memberA'), undefined, 'Count the orders')
  await page.route(`**/api/chats/${chatId}/job`, route => route.fulfill({
    json: { job: job(chatId, { state: 'ended', outcome: 'done', endedAt: at(START + 2 * 3_600_000 + 5 * 60_000), cost: { minor: 320, currency: 'USD' } }) },
  }))
  await signInAs(context, 'dana')
  await open(page, 'dana', `#/chats/${chatId}`)

  const card = page.locator('[data-job-status="ended"]')
  await expect(card.getByRole('heading', { name: 'Long job finished' })).toBeVisible()
  await expect(card).toContainText('Your Inhouse agent finished this task. Its answer is above.')
  await expect(card).toContainText('Ran for 2 h 5 min, cost $3.20.')
  await expect(page.locator('[data-job-status="running"]')).toHaveCount(0)
  await checkBothThemes(page, 'job-finished')
})
