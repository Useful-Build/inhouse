// The first read (`/api/me`) failing: a sign-in the Worker refuses (401) is the signed-out screen with "Sign in again",
// an Inhouse team account on the brand app (403 wrong_kind) is its own final screen with Sign out only, and a server
// error is the load error whose Retry brings the app back without a reload. None is the neutral loading screen (NotConnected), which shows only while the first read is in flight.
import type { Page } from '@playwright/test'
import { expect, test } from '../support/test-build/index.js'
import { inhouse, open, people, signInAs } from '../support/clients/real.js'
import { appOrigin, signIn } from '../support/test-build/index.js'

// The loading screen (src/shell/NotConnected.tsx): a status "Loading…" and an sr-only h1 "Loading Inhouse". A failure or a
// final screen replaces it, so none of these may show beside one.
const loadingScreen = (page: Page) => page.getByRole('status').filter({ hasText: 'Loading…' })
const loadingHeading = (page: Page) => page.getByRole('heading', { level: 1, name: 'Loading Inhouse', exact: true })

test('the first read in flight shows the neutral loading screen, then the app', async ({ page, context }) => {
  await signInAs(context, 'admin')
  let release!: () => void
  const held = new Promise<void>(r => { release = r })
  await page.route('**/api/me', async route => { await held; await route.continue() })
  await open(page, 'admin', '#/settings/team-plan')
  await expect(loadingScreen(page)).toBeVisible()
  await expect(loadingHeading(page)).toBeAttached()
  await expect(page.getByRole('heading', { name: 'Stage and plan', exact: true })).toHaveCount(0)
  release()
  await expect(page.getByRole('heading', { level: 1, name: 'Stage and plan', exact: true })).toBeVisible()
  await expect(loadingScreen(page)).toHaveCount(0)
  await expect(loadingHeading(page)).toHaveCount(0)
})

test('a token for another app (wrong audience) shows that the sign-in ended, and Sign in again reloads the page', async ({ page, context }) => {
  // The Inhouse app's token on the brand app: the Worker answers 401, as it does when the Access session has expired.
  await context.setExtraHTTPHeaders(await signIn(people.admin.subject, 'inhouse'))
  await open(page, 'admin')
  await expect(page.getByRole('heading', { level: 1, name: 'Your sign-in ended', exact: true })).toBeVisible()
  await expect(loadingScreen(page)).toHaveCount(0)
  await expect(loadingHeading(page)).toHaveCount(0)
  const again = page.getByRole('button', { name: 'Sign in again', exact: true })
  await Promise.all([page.waitForEvent('load'), again.click()])
  await expect(page.getByRole('heading', { level: 1, name: 'Your sign-in ended', exact: true })).toBeVisible()
})

test('an Inhouse team account on the brand app shows its own final screen: no Sign in again, no reload, no second read', async ({ page, context }) => {
  // P8a P-auth: Alex's subject is bound to the Inhouse team row, so the brand app answers 403 wrong_kind. Before, that
  // was a 401 and "Your sign-in ended", whose Sign in again came straight back (the loop).
  await context.setExtraHTTPHeaders(await signIn(inhouse.subject, 'brand'))
  const reads: string[] = []
  page.on('request', r => { if (new URL(r.url()).pathname.startsWith('/api/')) reads.push(new URL(r.url()).pathname) })
  await page.clock.install()
  await page.goto(`${appOrigin('brand')}/`)
  const loads: string[] = []
  page.on('load', () => loads.push(page.url()))
  await expect(page.getByRole('heading', { level: 1, name: 'This is an Inhouse team account', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Your sign-in ended' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Sign in again' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible()
  // Run any timer the page set (a minute of them), then check that nothing asked again or reloaded.
  await page.clock.runFor(60_000)
  expect(reads).toEqual(['/api/me'])
  expect(loads).toEqual([])
  // Sign out goes to Access's logout (the test build has no Access: only the request is checked, as in sign-out.spec.ts).
  // Per-PR hosts have no Access, so the edge answers the logout path without the app's CSP: not clicked there.
  if (process.env.E2E_TEST_BUILD_REMOTE) return
  const logout = page.waitForRequest(r => new URL(r.url()).pathname === '/cdn-cgi/access/logout' && r.isNavigationRequest())
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await logout
})

test('a 503 on the first read shows the load error, and Retry lands in the app', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await page.route('**/api/me', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable' } }) }))
  await open(page, 'admin', '#/settings/team-plan')
  const alert = page.getByRole('alert').filter({ hasText: "Couldn't load Inhouse." })
  await expect(alert).toBeVisible()
  await expect(loadingScreen(page)).toHaveCount(0)
  await expect(loadingHeading(page)).toHaveCount(0)
  // The read Retry makes is held until the checks below have run: while it is under way the load error stays, with
  // Retry disabled, and the loading screen never shows.
  await page.unroute('**/api/me')
  let release!: () => void
  const held = new Promise<void>(r => { release = r })
  await page.route('**/api/me', async route => { await held; await route.continue() })
  const loads: string[] = []
  page.on('load', () => loads.push(page.url()))
  const retry = alert.getByRole('button', { name: 'Retry', exact: true })
  await Promise.all([page.waitForRequest(r => new URL(r.url()).pathname === '/api/me'), retry.click()])
  await expect(retry).toBeDisabled()
  await expect(alert).toBeVisible()
  await expect(loadingScreen(page)).toHaveCount(0)
  await expect(loadingHeading(page)).toHaveCount(0)
  release()
  await expect(page.getByRole('heading', { level: 1, name: 'Stage and plan', exact: true })).toBeVisible()
  expect(loads).toEqual([])
})
