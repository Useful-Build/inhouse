// A `test` that fails when the page reports a Content-Security-Policy violation.
// Specs opt in with: import { expect, test } from './csp.js'
import { expect, test as base } from '@playwright/test'

type Violation = { directive: string; blocked: string; source: string }
declare global {
  interface Window { __cspViolations?: Violation[] }
}

export const test = base.extend<{ cspGuard: void }>({
  cspGuard: [async ({ page }, use) => {
    await page.addInitScript(() => {
      window.__cspViolations = []
      document.addEventListener('securitypolicyviolation', e => {
        window.__cspViolations?.push({ directive: e.violatedDirective, blocked: e.blockedURI, source: `${e.sourceFile}:${e.lineNumber}` })
      })
    })
    await use()
    const found = await page.evaluate(() => window.__cspViolations ?? []).catch(() => [] as Violation[])
    expect(found, `CSP violations: ${found.map(v => `${v.directive} blocked ${v.blocked} (${v.source})`).join('; ')}`).toEqual([])
  }, { auto: true }],
})

export { expect }
