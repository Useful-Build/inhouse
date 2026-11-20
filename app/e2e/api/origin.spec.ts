// `Origin` on every write (p2-design section 2): a signed-in caller whose Origin is missing, another site's, `null` or
// sent with `Sec-Fetch-Site: cross-site` gets 403 `bad_origin`, before the route runs. OPTIONS answers 405 (no CORS).
import { expect, test } from '@playwright/test'
import { caseFor } from './cases.ts'
import { actor, appOrigin, call, expectError, matrixRows, rowKey } from './kit.ts'
import type { CallOptions } from './kit.ts'

const admin = actor('admin')
const rows = matrixRows()
const writes = rows.filter(r => r.method !== 'GET')

const bodyOf = (row: (typeof rows)[number]): CallOptions => {
  const c = caseFor(row)
  return { ...(c.json !== undefined ? { json: c.json } : {}), ...(c.bytes ? { bytes: c.bytes.content, contentType: c.bytes.contentType } : {}) }
}

const badOrigins: { name: string; options: CallOptions }[] = [
  { name: 'no Origin', options: { origin: null } },
  { name: 'another origin', options: { origin: 'https://evil.example.test' } },
  { name: 'the other app\'s origin', options: { origin: appOrigin('inhouse') } },
  { name: 'Origin: null', options: { origin: 'null' } },
  { name: 'the right Origin with Sec-Fetch-Site: cross-site', options: { headers: { 'Sec-Fetch-Site': 'cross-site' } } },
  { name: 'the right Origin with Sec-Fetch-Site: same-site', options: { headers: { 'Sec-Fetch-Site': 'same-site' } } },
]

for (const row of writes) {
  for (const bad of badOrigins) {
    test(`${rowKey(row)} with ${bad.name} is 403 bad_origin`, async ({ request }) => {
      expectError(await call(request, admin, row.method, caseFor(row).path, { ...bodyOf(row), ...bad.options }), 403, 'forbidden', 'bad_origin')
    })
  }
  test(`${rowKey(row)} with the right Origin and Sec-Fetch-Site: same-origin gets past the check`, async ({ request }) => {
    // P3's drain and warm-up are the release token's (open rows): it sends the brand Origin like any client.
    const who = row.services.includes('release') ? actor('release') : admin
    const r = await call(request, who, row.method, caseFor(row).path, { ...bodyOf(row), headers: { 'Sec-Fetch-Site': 'same-origin' } })
    expect(r.status, r.text).not.toBe(403)
  })
}

for (const row of rows) {
  test(`OPTIONS ${rowKey(row)} is 405, with a sign-in or without`, async ({ request }) => {
    const path = caseFor(row).path
    const signedIn = await call(request, admin, 'OPTIONS', path)
    expect(signedIn.status, signedIn.text).toBe(405)
    expect(signedIn.headers.allow).toBe('GET, HEAD, POST, PUT, DELETE')
    expect(signedIn.headers['access-control-allow-origin'], 'the API serves no CORS').toBeUndefined()
    // Without a sign-in the 401 comes first, as for every other method.
    expectError(await call(request, admin, 'OPTIONS', path, { token: null }), 401, 'unauthorized')
  })
}

test('a write on the Inhouse hostname needs the Inhouse origin, not the brand one', async ({ request }) => {
  const alex = actor('inhouse')
  expectError(await call(request, alex, 'POST', '/api/client-error', { json: {}, origin: appOrigin('brand') }), 403, 'forbidden', 'bad_origin')
  const ok = await call(request, alex, 'POST', '/api/client-error', { json: {} })
  expect(ok.status, ok.text).not.toBe(403)
})
