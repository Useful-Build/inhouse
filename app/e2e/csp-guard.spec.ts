import { expect, test } from './csp.js'

// Self-test of the CSP guard: a real violation must fail the test, so this is expected to fail. If the guard goes
// fail-open (the binding is not armed, the header is gone), this test starts passing and Playwright reports it.
test.fail('The CSP guard fails a test that provokes a violation', async ({ page }) => {
  await page.goto('/?demo#/today')
  await expect(page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening)/ })).toBeVisible()
  // The policy allows no inline script, so this one is blocked and fires securitypolicyviolation.
  await page.evaluate(() => {
    const s = document.createElement('script')
    s.textContent = 'window.__cspProbe = 1'
    document.head.append(s)
  })
  // The fixture's teardown waits one animation frame, then asserts there were no violations.
})
