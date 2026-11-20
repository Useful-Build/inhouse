// The first read (`/api/me`) failing: a sign-in the Worker refuses (401) is the signed-out screen with "Sign in again",
// and a server error is the load error whose Retry brings the app back without a reload. Neither is "Not connected yet".
import { expect, test } from '../support/test-build/index.js'
import { open, people, signInAs } from '../support/clients/real.js'
import { signIn } from '../support/test-build/index.js'

test('a token for another app (wrong audience) shows that the sign-in ended, and Sign in again reloads the page', async ({ page, context }) => {
  // The Inhouse app's token on the brand app: the Worker answers 401, as it does when the Access session has expired.
  await context.setExtraHTTPHeaders(await signIn(people.admin.subject, 'inhouse'))
  await open(page, 'admin')
  await expect(page.getByRole('heading', { level: 1, name: 'Your sign-in ended', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Not connected yet' })).toHaveCount(0)
  const again = page.getByRole('button', { name: 'Sign in again', exact: true })
  await Promise.all([page.waitForEvent('load'), again.click()])
  await expect(page.getByRole('heading', { level: 1, name: 'Your sign-in ended', exact: true })).toBeVisible()
})

test('a 503 on the first read shows the load error, and Retry lands in the app', async ({ page, context }) => {
  await signInAs(context, 'admin')
  await page.route('**/api/me', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable' } }) }))
  await open(page, 'admin', '#/settings/team-plan')
  const alert = page.getByRole('alert').filter({ hasText: "Couldn't load Inhouse." })
  await expect(alert).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Not connected yet' })).toHaveCount(0)
  await page.unroute('**/api/me')
  const loads: string[] = []
  page.on('load', () => loads.push(page.url()))
  await alert.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Stage and plan', exact: true })).toBeVisible()
  expect(loads).toEqual([])
})
