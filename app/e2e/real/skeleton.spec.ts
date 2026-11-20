// PR0's proof that the test build serves the product SPA under the enforced CSP (the guard fails the test on any
// violation or a document without the header). Later phases' `real` specs sign in with `signIn`.
import { appOrigin, expect, test } from '../support/test-build/index.js'

test('The test build serves the product app with its CSP', async ({ page }) => {
  const res = await page.goto(`${appOrigin('brand')}/`)
  expect(res?.headers()['content-security-policy']).toContain("default-src 'self'")
  await expect(page.getByRole('heading', { level: 1, name: 'Not connected yet', exact: true })).toBeVisible()
})
