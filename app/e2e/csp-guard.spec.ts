import { expect, test } from './csp.js'

// Self-test of the CSP guard (csp.ts): a real violation must be recorded by it. With `cspExpectViolation` the guard's
// teardown asserts it saw one, so this passes only when the header is served, the binding is armed and the listener
// reports. A page that fails to load, or a policy that lets the script run, fails it.
test.use({ cspExpectViolation: true })

test('The CSP guard records a violation a page provokes', async ({ page }) => {
  await page.goto('/?demo#/today')
  await expect(page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening)/ })).toBeVisible()
  // The policy allows no inline script, so this one is blocked and fires securitypolicyviolation.
  const ran = await page.evaluate(() => {
    const s = document.createElement('script')
    s.textContent = 'window.__cspProbe = 1'
    document.head.append(s)
    return (window as Window & { __cspProbe?: number }).__cspProbe === 1
  })
  expect(ran, 'the inline script ran, so the policy did not block it').toBe(false)
})
