// PR0's proof that the test build serves the API: with no Access JWT every /api/* path is 401 `unauthorized`, before
// any route lookup (an unknown path too, not 404), with the security headers and no-store. W6 owns e2e/api/ from here.
import { expect, test } from '@playwright/test'
import { appOrigin } from '../support/test-build/index.js'

for (const [method, path] of [['GET', '/api/me'], ['GET', '/api/no-such-route'], ['POST', '/api/members/invites']] as const) {
  test(`${method} ${path} without a JWT is 401 unauthorized`, async ({ request }) => {
    const res = await request.fetch(`${appOrigin('brand')}${path}`, { method, failOnStatusCode: false })
    expect(res.status()).toBe(401)
    expect(await res.json()).toEqual({ error: { code: 'unauthorized' } })
    const headers = res.headers()
    expect(headers['cache-control']).toBe('no-store')
    expect(headers['content-security-policy']).toContain("default-src 'self'")
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['x-robots-tag']).toBe('noindex, nofollow')
  })
}
