// Authentication on every route (p2-design sections 2 to 4): every kind of bad sign-in answers 401 `unauthorized` with
// no detail, before the Origin check and before any route lookup. The sign-in is the same on all routes, and each route
// is tried with each kind, with the right Origin on writes so the 401 is the sign-in's and nothing else's.
import { expect, test } from '@playwright/test'
import { caseFor } from './cases.ts'
import { actor, appOrigin, audOf, call, expectError, matrixRows, mint, rowKey } from './kit.ts'
import type { Actor, AppName } from './kit.ts'
import { newTestIssuerKey } from '../../server/auth/test-issuer-mint.ts'
import { SEED_INHOUSE, SEED_PEOPLE } from '../../server/seed/brand.ts'

const admin = actor('admin')
const smoke = actor('smoke')
const HOUR = 3_600_000
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')

/** A request's sign-in problem: the token to send (or none) and where to send it. */
interface Bad { name: string; app: AppName; token: () => Promise<string | null>; to?: string; remoteSkip?: string }

const bads: Bad[] = [
  { name: 'no header', app: 'brand', token: async () => null },
  { name: 'garbage', app: 'brand', token: async () => 'not-a-jwt' },
  { name: 'three dotted words', app: 'brand', token: async () => 'abc.def.ghi' },
  { name: 'a JWT from another key', app: 'brand', token: async () => mint(admin, { key: (await newTestIssuerKey()).privateJwk }) },
  { name: 'an expired JWT', app: 'brand', token: async () => mint(admin, { nowMs: Date.now() - HOUR, lifetimeS: 60 }) },
  { name: 'not yet valid', app: 'brand', token: async () => mint(admin, { nbfMs: Date.now() + HOUR }) },
  { name: "the Inhouse app's aud on the brand hostname", app: 'brand', token: async () => mint(admin, { aud: audOf('inhouse') }) },
  { name: "the brand app's aud on the Inhouse hostname", app: 'inhouse', token: async () => mint(actor('inhouse'), { aud: audOf('brand') }) },
  {
    name: 'the right aud on the wrong hostname',
    app: 'brand',
    token: async () => mint(admin),
    to: `http://127.0.0.1:${new URL(appOrigin('brand')).port}`,
    remoteSkip: 'a deployed test build has no second hostname reaching the same Worker (workers_dev off); proven by the local test-build suite',
  },
  { name: 'another issuer', app: 'brand', token: async () => mint(admin, { iss: 'https://not-the-issuer.invalid' }) },
  {
    name: 'alg none',
    app: 'brand',
    token: async () => {
      const claims = { iss: 'https://test-issuer.invalid', aud: [audOf('brand')], sub: SEED_PEOPLE.admin.subject, email: SEED_PEOPLE.admin.email, type: 'app', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 }
      return `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.x`
    },
  },
  {
    name: 'alg none with no signature',
    app: 'brand',
    token: async () => `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ iss: 'https://test-issuer.invalid', aud: [audOf('brand')], sub: 'x', email: 'x@example.test', exp: Math.floor(Date.now() / 1000) + 600 })}.`,
  },
  { name: 'a service token on the Inhouse hostname', app: 'inhouse', token: async () => mint(smoke, { aud: audOf('inhouse') }) },
  { name: 'an unknown service client id', app: 'brand', token: async () => mint({ app: 'brand', clientId: 'nobody-test-client.access' }) },
]

for (const row of matrixRows()) {
  const c = caseFor(row)
  for (const bad of bads) {
    test(`${rowKey(row)} with ${bad.name} is 401`, async ({ request }) => {
      test.skip(!!process.env.E2E_TEST_BUILD_REMOTE && bad.remoteSkip !== undefined, bad.remoteSkip)
      const token = await bad.token()
      // The caller only supplies the app (its origin); the token is the one under test.
      const who: Actor = { app: bad.app, sub: 'unused', email: 'unused@example.test' }
      const r = await call(request, who, row.method, c.path, {
        token, to: bad.to, origin: row.method === 'GET' ? null : appOrigin(bad.app),
        ...(c.json !== undefined ? { json: c.json } : {}),
        ...(c.bytes ? { bytes: c.bytes.content, contentType: c.bytes.contentType } : {}),
      })
      expectError(r, 401, 'unauthorized')
    })
  }
}

test('an unknown path without a JWT is 401, not 404, and with one it is 404', async ({ request }) => {
  expectError(await call(request, admin, 'GET', '/api/no-such-route', { token: null }), 401, 'unauthorized')
  expectError(await call(request, admin, 'GET', '/api/no-such-route'), 404, 'not_found')
})

test('the Inhouse hostname signs in its own people, and refuses the brand app\'s aud', async ({ request }) => {
  const alex = actor('inhouse')
  expect((await call(request, alex, 'GET', '/api/me')).status).toBe(200)
  // The same person, minted for the brand app, sent to the Inhouse hostname.
  const wrongAud = await mint(alex, { aud: audOf('brand') })
  expectError(await call(request, alex, 'GET', '/api/me', { token: wrongAud }), 401, 'unauthorized')
})

test('a brand-app person is never an Inhouse principal, and an Inhouse person is not a brand member', async ({ request }) => {
  // Sam's subject on the Inhouse hostname is a new Inhouse person (no role), not the Admin.
  const asInhouse = await call(request, { app: 'inhouse', sub: SEED_PEOPLE.admin.subject, email: SEED_PEOPLE.admin.email }, 'GET', '/api/me')
  expect(asInhouse.status, asInhouse.text).toBe(200)
  expect(asInhouse.json.role).toBe('inhouse')
  // Alex's subject on the brand hostname is bound to an `inhouse` row: refused 401, never a member.
  const asBrand = await call(request, { app: 'brand', sub: SEED_INHOUSE.subject, email: SEED_INHOUSE.email }, 'GET', '/api/me')
  expectError(asBrand, 401, 'unauthorized')
})
