// Client error reporting (H4): a screen that throws shows its own boundary inside the shell and sends one scrubbed
// report to /api/client-error; an unhandled rejection sends one; the Worker answers other /api paths with 404 and the
// security headers from public/_headers, and refuses posts from other sites; source maps are never served. The errors
// come from the demo switch `?demo&crash=screen|rejection` (src/report-error.ts), which does nothing without `?demo`
// in a production build.
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

type Report = { message: string; stack: string; url: string; release: string; kind: string; demo?: boolean }

/** Records every report the page sends, and answers it without reaching the Worker. */
async function recordReports(page: Page): Promise<Report[]> {
  const reports: Report[] = []
  await page.route('**/api/client-error', async route => {
    reports.push(route.request().postDataJSON() as Report)
    await route.fulfill({ status: 204 })
  })
  return reports
}

function expectScrubbed(r: Report) {
  const all = JSON.stringify(r)
  expect(all).not.toContain('qa.person@example.com')
  expect(all).not.toContain('demo0123456789abcdefghijklmn')
  expect(all).not.toContain('secret=1')
  expect(all).not.toContain('#frag')
  expect(r.url).not.toMatch(/[?#]/)
  expect(r.url).toMatch(/^https?:\/\/[^/]+\/$/)
  expect(r.release).toMatch(/^[\w.-]+$/)
}

test('A screen that throws shows its own boundary, keeps the shell and sends one scrubbed report', async ({ page }) => {
  const reports = await recordReports(page)
  await page.goto('/?demo&crash=screen#/today')

  const boundary = page.getByRole('main').getByRole('alert')
  await expect(boundary.getByRole('heading', { level: 2, name: 'Something went wrong.' })).toBeVisible()
  // The shell is still there: the sidebar works and the full-page crash screen didn't show.
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: 'Something went wrong.' })).toHaveCount(0)

  await expect.poll(() => reports.length).toBe(1)
  const [r] = reports
  expect(r.kind).toBe('route')
  expect(r.demo).toBe(true)
  expect(r.message).toContain('Demo crash for [email] with token=[token]')
  expect(r.message).toMatch(/on https:\/\/inhouse\.example\/p$/)
  expectScrubbed(r)

  // "Message the team" opens the team window in place, on Report a bug, with a line about the crash.
  await boundary.getByRole('button', { name: 'Message the team' }).click()
  const team = page.getByRole('dialog', { name: 'Your Inhouse team' })
  await expect(team).toBeVisible()
  await expect(team.getByRole('radio', { name: /Report a bug/ })).toBeChecked()
  await expect(team.getByRole('textbox', { name: 'Your request' })).toHaveValue(/The Today screen crashed/)

  // Still one report: the same error isn't sent twice.
  expect(reports).toHaveLength(1)
})

test('An unhandled promise rejection sends one scrubbed report and the page still works', async ({ page }) => {
  const reports = await recordReports(page)
  await page.goto('/?demo&crash=rejection#/today')
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: 'Something went wrong.' })).toHaveCount(0)

  await expect.poll(() => reports.length).toBe(1)
  const [r] = reports
  expect(r.kind).toBe('rejection')
  expect(r.demo).toBe(true)
  expect(r.message).toContain('Demo rejection for [email] with token=[token]')
  expectScrubbed(r)
})

test('The Worker: unknown /api paths are 404, the report route checks its input, every answer has the security headers', async ({ page }) => {
  // The headers the Worker must copy from the `/*` block of public/_headers.
  const file = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8')
  const expected: [string, string][] = []
  let inAll = false
  for (const line of file.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    if (!/^\s/.test(line)) { inAll = line.trim() === '/*'; continue }
    const i = line.indexOf(':')
    if (inAll && i > 0) expected.push([line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()])
  }
  expect(expected.length).toBeGreaterThan(0)

  const unknown = await page.request.get('/api/unknown')
  expect(unknown.status()).toBe(404)
  for (const [name, value] of expected) expect(unknown.headers()[name], name).toBe(value)
  expect((await page.request.post('/api/unknown', { data: {} })).status()).toBe(404)

  expect((await page.request.get('/api/client-error')).status()).toBe(405)
  expect((await page.request.post('/api/client-error', { data: 'not json', headers: { 'Content-Type': 'text/plain' } })).status()).toBe(400)
  expect((await page.request.post('/api/client-error', { data: { message: 'x'.repeat(9 * 1024) } })).status()).toBe(413)
  const ok = await page.request.post('/api/client-error', { data: { message: 'E2E report', stack: '', url: 'http://localhost/', release: 'dev', kind: 'error' } })
  expect(ok.status()).toBe(204)
  for (const [name, value] of expected) expect(ok.headers()[name], name).toBe(value)
})

test('A report posted from the page reaches the Worker (the CSP allows it), and a post from another site is refused', async ({ page }) => {
  await page.goto('/#/today')
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
  // A real same-origin post from the browser, not routed: the enforced CSP must allow it and the Worker answer 204.
  const status = await page.evaluate(async () => {
    const body = JSON.stringify({ message: 'E2E browser report', stack: '', url: location.href, release: 'dev', kind: 'error' })
    const res = await fetch('/api/client-error', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } })
    return res.status
  })
  expect(status).toBe(204)

  // Another site's page posting here: its Origin isn't ours.
  const cross = await page.request.post('/api/client-error', {
    data: { message: 'cross-site', stack: '', url: 'https://other.example/', release: 'dev', kind: 'error' },
    headers: { Origin: 'https://other.example' },
  })
  expect(cross.status()).toBe(403)
})

test('No source map is served, and the scripts don\'t point at one', async ({ page }) => {
  await page.goto('/#/today')
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
  const scripts = await page.locator('script[src]').evaluateAll(els => els.map(e => (e as HTMLScriptElement).src))
  expect(scripts.length).toBeGreaterThan(0)
  for (const src of scripts) {
    const js = await page.request.get(src)
    expect(js.status()).toBe(200)
    expect(await js.text()).not.toContain('sourceMappingURL')
    const map = await page.request.get(`${src}.map`)
    // A miss may fall through to a 404 or the app's index.html; it must never be the map itself.
    expect(await map.text()).not.toContain('"mappings"')
  }
})
