// A `test` that fails when any page in the test's browser context reports a Content-Security-Policy violation.
// Specs opt in with: import { expect, test } from './csp.js'
import { expect, test as base } from '@playwright/test'

type Violation = { directive: string; blocked: string; source: string; page: string }
declare global {
  interface Window { __cspReport?: (v: Violation) => void }
}

export const test = base.extend<{ cspGuard: void }>({
  cspGuard: [async ({ context }, use) => {
    const found: Violation[] = []
    // The guard is only armed if the app's documents carry the CSP: record any that don't.
    const unguarded: string[] = []
    context.on('response', response => {
      const request = response.request()
      if (request.resourceType() !== 'document' || response.status() >= 300) return
      if (!response.headers()['content-security-policy']) unguarded.push(response.url())
    })
    await context.exposeBinding('__cspReport', (_source, v: Violation) => { found.push(v) })
    await context.addInitScript(() => {
      const report = window.__cspReport // captured once, so a page script can't swap it out later
      document.addEventListener('securitypolicyviolation', e => {
        report?.({ directive: e.violatedDirective, blocked: e.blockedURI, source: `${e.sourceFile}:${e.lineNumber}`, page: location.href })
      })
    })
    await use()
    expect(unguarded, `Pages served without a Content-Security-Policy header, so violations can't be caught: ${unguarded.join(', ')}`).toEqual([])
    // Let queued violation events fire (no timers): one animation frame per open page.
    for (const page of context.pages()) {
      if (page.isClosed()) continue
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null)))).catch((err: unknown) => {
        if (!page.isClosed()) throw err
      })
    }
    expect(found, `CSP violations: ${found.map(v => `${v.directive} blocked ${v.blocked} (${v.source}) on ${v.page}`).join('; ')}`).toEqual([])
  }, { auto: true }],
})

export { expect }
