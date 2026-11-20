// Headers: every `/api/*` answer, errors included, carries the security headers from public/_headers and
// `Cache-Control: no-store`. The one exception is a member's photo bytes (route 15), which carry a stricter CSP and
// `private, no-cache`, and nothing else differs. The API serves no CORS.
import { expect, test } from '@playwright/test'
import { caseFor } from './cases.ts'
import { actor, appOrigin, call, endLiveGrants, imageBytes, matrixRows, me, rowKey, securityHeaders } from './kit.ts'
import type { Reply } from './kit.ts'

const headers = securityHeaders()
const admin = actor('admin')

function expectSecure(r: Reply, what: string): void {
  for (const [name, value] of headers) expect(r.headers[name], `${what}: ${name}`).toBe(value)
  expect(r.headers['cache-control'], `${what}: cache-control`).toBe('no-store')
  expect(r.headers['access-control-allow-origin'], `${what}: no CORS`).toBeUndefined()
}

test.describe.configure({ mode: 'serial' })

for (const row of matrixRows()) {
  const c = caseFor(row)
  const body = { ...(c.json !== undefined ? { json: c.json } : {}), ...(c.bytes ? { bytes: c.bytes.content, contentType: c.bytes.contentType } : {}) }
  test(`${rowKey(row)}: its answers carry the headers (a success or its handler's error, a 403, a 401)`, async ({ request }) => {
    expectSecure(await call(request, admin, row.method, c.path, body), 'signed in as Admin')
    // A caller the row refuses: the Inhouse team can't reach most writes and `monitor` reaches nothing but health.
    expectSecure(await call(request, actor('monitor'), row.method, c.path, { ...body, origin: appOrigin('brand') }), 'monitor')
    expectSecure(await call(request, admin, row.method, c.path, { ...body, token: null }), 'no sign-in')
  })
}

test('the other errors carry them too: 404, 405, bad origin, a refused body', async ({ request }) => {
  expectSecure(await call(request, admin, 'GET', '/api/no-such-route'), '404')
  expectSecure(await call(request, admin, 'OPTIONS', '/api/me'), '405')
  expectSecure(await call(request, admin, 'POST', '/api/grants', { json: {}, origin: 'https://evil.example.test' }), 'bad origin')
  expectSecure(await call(request, admin, 'POST', '/api/members/invites', { bytes: Buffer.alloc(20_000, 0x41), contentType: 'application/json' }), 'a body over the cap')
  expectSecure(await call(request, admin, 'GET', '/api/audit?limit=0'), 'bad query')
  expectSecure(await call(request, actor('memberA'), 'GET', '/api/health'), 'health refused')
})

test('a photo carries its own CSP and `private, no-cache`, and every other header', async ({ request }) => {
  const dana = actor('memberA')
  const id = (await me(request, dana)).memberId
  await call(request, dana, 'PUT', '/api/photo', { bytes: imageBytes('image/png'), contentType: 'image/png' })
  try {
    const r = await call(request, dana, 'GET', `/api/members/${id}/photo`)
    expect(r.status).toBe(200)
    for (const [name, value] of headers.filter(([n]) => n !== 'content-security-policy')) expect(r.headers[name], name).toBe(value)
    expect(r.headers['content-security-policy']).toBe("default-src 'none'; sandbox")
    expect(r.headers['cache-control']).toBe('private, no-cache')
  } finally {
    await call(request, dana, 'DELETE', '/api/photo')
  }
})

test('the CSV export carries them, and a grant read by the Inhouse team does too', async ({ request }) => {
  expectSecure(await call(request, admin, 'GET', '/api/audit/export.csv'), 'csv')
  await endLiveGrants(request)
  const made = await call(request, admin, 'POST', '/api/grants', { json: { hours: 1 } })
  expectSecure(made, 'grant created')
  try {
    expectSecure(await call(request, actor('inhouse'), 'GET', '/api/members'), 'Inhouse under a grant')
  } finally {
    await endLiveGrants(request)
  }
})
