// A routine's "Last runs" panel on the test build (route 86, `GET /api/routines/:id/runs`): the outcome icons for a failed and a
// skipped run, and the "Try again" state when the list can't be read. The demo's sample runs all finished and a real run's end
// can't be made to fail on demand, so each test answers route 86 itself (Playwright's `page.route`, on the morning check, the one
// routine the test build always has): the page, the client's reading of the answer and the panel are the real ones. The unit tests
// (src/state/routine-run-lines.test.ts, src/agent/http/routines.test.ts) cover the lines and the read; this is the page.
// Ways it can fail, written first:
//  1. a failed or a skipped run shows another run's icon, or a done icon (an outcome read as the wrong one);
//  2. a list that can't load says "Not run yet." (reads as no runs) or nothing, instead of the error line with Try again;
//  3. Try again doesn't ask again, or leaves the error line up after the list loads.
// The answer is held by a flag the test flips, never by a timer.
import type { Page } from '@playwright/test'
import { open, signInAs } from '../support/clients/real.js'
import { expect, test } from '../support/test-build/index.js'

const MORNING_CHECK = 'routine-morning-check'
const RUNS_URL = `**/api/routines/${MORNING_CHECK}/runs`

const at = (agoMs: number) => { const ms = Date.now() - agoMs; return { iso: new Date(ms).toISOString(), ms } }
const HOUR = 3_600_000
/** Newest first, as route 86 gives them. */
const RUNS = [
  { at: at(1 * HOUR), outcome: 'failed', result: "The morning check didn't finish. Nothing was changed.", manual: false },
  { at: at(2 * HOUR), outcome: 'skipped', result: 'Skipped. Your Inhouse agent was paused.', manual: false },
  { at: at(3 * HOUR), outcome: 'done', result: 'Read 5 tools, found 3 things', manual: false },
]

async function openMorningCheck(page: Page): Promise<void> {
  await page.locator(`[data-routine-open="${MORNING_CHECK}"]`).click()
  await expect(page.getByRole('dialog', { name: 'Morning check' })).toBeVisible()
}

test('a failed and a skipped run each show their own icon and plain line in Last runs', async ({ page, context }) => {
  await signInAs(context, 'dana')
  await page.route(RUNS_URL, route => route.fulfill({ json: { runs: RUNS } }))
  await open(page, 'dana', '#/routines')
  await openMorningCheck(page)

  const lines = page.getByRole('dialog', { name: 'Morning check' }).getByRole('list', { name: 'Last runs' }).getByRole('listitem')
  await expect(lines).toHaveCount(3)
  // The icon is a Material Symbols ligature: its text is the glyph's name (aria-hidden, so it has no role to ask for).
  await expect(lines.nth(0).locator('span.ms').first()).toHaveText('error')
  await expect(lines.nth(0)).toContainText("The morning check didn't finish. Nothing was changed.")
  await expect(lines.nth(1).locator('span.ms').first()).toHaveText('do_not_disturb_on')
  await expect(lines.nth(1)).toContainText('Skipped. Your Inhouse agent was paused.')
  await expect(lines.nth(2).locator('span.ms').first()).toHaveText('check_circle')
  await expect(lines.nth(2)).toContainText('Read 5 tools, found 3 things')
  // Never the empty list's words, and no error line: the list loaded.
  await expect(page.getByText('Not run yet.')).toHaveCount(0)
  await expect(page.getByText("Couldn't load the last runs.")).toHaveCount(0)
})

test('a list that can\'t load says so with Try again, and Try again asks again and shows the runs', async ({ page, context }) => {
  await signInAs(context, 'dana')
  let failing = true
  let asked = 0
  await page.route(RUNS_URL, route => {
    asked++
    return failing ? route.fulfill({ status: 503, json: { error: { code: 'unavailable' } } }) : route.fulfill({ json: { runs: RUNS } })
  })
  await open(page, 'dana', '#/routines')
  await openMorningCheck(page)

  const sheet = page.getByRole('dialog', { name: 'Morning check' })
  const notice = sheet.getByRole('status').filter({ hasText: "Couldn't load the last runs." })
  await expect(notice).toBeVisible()
  // An error is not an empty list.
  await expect(sheet.getByText('Not run yet.')).toHaveCount(0)
  await expect(sheet.getByRole('list', { name: 'Last runs' })).toHaveCount(0)
  const askedBefore = asked

  failing = false
  await notice.getByRole('button', { name: 'Try again' }).click()
  await expect(sheet.getByRole('list', { name: 'Last runs' }).getByRole('listitem')).toHaveCount(3)
  expect(asked, 'Try again asked route 86 again').toBeGreaterThan(askedBefore)
  await expect(sheet.getByText("Couldn't load the last runs.")).toHaveCount(0)
  await expect(sheet.getByRole('button', { name: 'Try again' })).toHaveCount(0)
})
