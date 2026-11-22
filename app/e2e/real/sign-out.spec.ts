// Acceptance 4, Sign out: the account menu sends the browser to the Access logout path the client builds
// (src/agent/http/client.ts signOutUrl). The test build has no Access, so only the request is checked; the real
// Access logout is checked on the candidate deploy. It would fail if Sign out did nothing or went elsewhere.
import { test } from '../support/test-build/index.js'
import { open, signInAs } from '../support/clients/real.js'

test('Sign out goes to the Access logout path', async ({ page, context }) => {
  test.skip(!!process.env.E2E_TEST_BUILD_REMOTE, 'per-PR hosts have no Access, so the edge answers /cdn-cgi/access/logout without the app\'s CSP; proven by the local test-build suite, and the real logout on the candidate (behind Access)')
  await signInAs(context, 'admin')
  await open(page, 'admin', '#/today')
  // On a phone the sidebar is a drawer behind the Menu button: wait for the button, then open it.
  if ((page.viewportSize()?.width ?? 1440) < 600) await page.getByRole('button', { name: 'Menu' }).click()
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: /account and settings/i }).click()
  const logout = page.waitForRequest(r => new URL(r.url()).pathname === '/cdn-cgi/access/logout' && r.isNavigationRequest())
  await page.getByRole('menu', { name: 'Account' }).getByRole('menuitem', { name: 'Sign out', exact: true }).click()
  await logout
})
