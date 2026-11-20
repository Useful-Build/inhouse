// Photos (p2-design section 3, routes 13 to 15): PNG, JPEG and WebP are accepted by their first bytes; anything else, a
// Content-Type that names another type and a body over 1 MiB are refused; the download carries `nosniff` and the type
// stored at upload, and goes only to who the row allows; a Member can't touch another Member's photo.
import { expect, test } from '@playwright/test'
import { actor, allPages, call, endLiveGrants, expectError, imageBytes, me } from './kit.ts'
import type { ImageType } from './kit.ts'

const dana = actor('memberA')
const leo = actor('memberB')
test.describe.configure({ mode: 'serial' })
test.beforeAll(async ({ request }) => { await endLiveGrants(request) })
test.afterAll(async ({ request }) => {
  for (const who of [dana, leo]) await call(request, who, 'DELETE', '/api/photo')
})

/** The member row's rev as the team list serves it: a photo answer's `rev` must be this, read back after the write. */
async function revOf(request: Parameters<typeof allPages>[0], id: string): Promise<number> {
  const { items } = await allPages<{ id: string; rev: number }>(request, actor('admin'), '/api/members', 100)
  return items.find(m => m.id === id)!.rev
}

const TYPES: ImageType[] = ['image/png', 'image/jpeg', 'image/webp']

for (const type of TYPES) {
  test(`${type} is accepted, served back byte for byte with its stored type and nosniff`, async ({ request }) => {
    const id = (await me(request, dana)).memberId
    const bytes = imageBytes(type, 200)
    const put = await call(request, dana, 'PUT', '/api/photo', { bytes, contentType: type })
    expect(put.status, put.text).toBe(200)
    expect(put.json).toEqual({ photoUrl: `/api/members/${id}/photo`, rev: await revOf(request, id) })
    expect((await me(request, dana)).photoUrl).toBe(put.json.photoUrl)
    // Any member, and the Admin, reads it.
    for (const who of [dana, leo, actor('admin')]) {
      const got = await call(request, who, 'GET', put.json.photoUrl)
      expect(got.status, got.text).toBe(200)
      expect(got.headers['content-type']).toBe(type)
      expect(got.headers['x-content-type-options']).toBe('nosniff')
      expect(got.headers['content-security-policy']).toBe("default-src 'none'; sandbox")
      expect(got.headers['cache-control']).toBe('private, no-cache')
      expect(got.bytes.equals(bytes)).toBe(true)
    }
  })
}

test('a replaced photo is the new one', async ({ request }) => {
  const url = `/api/members/${(await me(request, dana)).memberId}/photo`
  await call(request, dana, 'PUT', '/api/photo', { bytes: imageBytes('image/png', 100), contentType: 'image/png' })
  const next = imageBytes('image/jpeg', 150)
  expect((await call(request, dana, 'PUT', '/api/photo', { bytes: next, contentType: 'image/jpeg' })).status).toBe(200)
  const got = await call(request, leo, 'GET', url)
  expect(got.headers['content-type']).toBe('image/jpeg')
  expect(got.bytes.equals(next)).toBe(true)
})

test.describe('refused uploads leave the photo as it was', () => {
  const MIB = 1024 * 1024
  const refused: { name: string; bytes: () => Buffer; contentType: string; reason: 'bad_type' | 'too_large' }[] = [
    { name: 'a GIF', bytes: () => Buffer.from('GIF89a\u0001\u0000\u0001\u0000', 'latin1'), contentType: 'image/gif', reason: 'bad_type' },
    { name: 'a GIF labelled as a PNG', bytes: () => Buffer.from('GIF89a\u0001\u0000\u0001\u0000', 'latin1'), contentType: 'image/png', reason: 'bad_type' },
    { name: 'an SVG', bytes: () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'), contentType: 'image/svg+xml', reason: 'bad_type' },
    { name: 'an SVG labelled as a PNG', bytes: () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), contentType: 'image/png', reason: 'bad_type' },
    { name: 'a text file renamed .png', bytes: () => Buffer.from('this is not a picture'), contentType: 'image/png', reason: 'bad_type' },
    { name: 'an empty body', bytes: () => Buffer.alloc(0), contentType: 'image/png', reason: 'bad_type' },
    { name: 'a PNG sent as image/jpeg (mismatched Content-Type)', bytes: () => imageBytes('image/png'), contentType: 'image/jpeg', reason: 'bad_type' },
    { name: 'a JPEG sent as application/octet-stream', bytes: () => imageBytes('image/jpeg'), contentType: 'application/octet-stream', reason: 'bad_type' },
    { name: 'RIFF....AVI declared as WebP', bytes: () => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('AVI '), Buffer.alloc(40)]), contentType: 'image/webp', reason: 'bad_type' },
    { name: 'ff d8 alone declared as JPEG', bytes: () => Buffer.from([0xff, 0xd8]), contentType: 'image/jpeg', reason: 'bad_type' },
    { name: 'a 4-byte PNG head', bytes: () => Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentType: 'image/png', reason: 'bad_type' },
    { name: 'a PNG one byte over 1 MiB', bytes: () => imageBytes('image/png', MIB + 1), contentType: 'image/png', reason: 'too_large' },
  ]
  for (const bad of refused) {
    test(`${bad.name} is 400 ${bad.reason}`, async ({ request }) => {
      const url = `/api/members/${(await me(request, dana)).memberId}/photo`
      const keep = imageBytes('image/webp', 90)
      expect((await call(request, dana, 'PUT', '/api/photo', { bytes: keep, contentType: 'image/webp' })).status).toBe(200)
      expectError(await call(request, dana, 'PUT', '/api/photo', { bytes: bad.bytes(), contentType: bad.contentType }), 400, 'invalid', bad.reason)
      const got = await call(request, leo, 'GET', url)
      expect(got.headers['content-type']).toBe('image/webp')
      expect(got.bytes.equals(keep)).toBe(true)
    })
  }

  test('exactly 1 MiB is accepted', async ({ request }) => {
    const r = await call(request, dana, 'PUT', '/api/photo', { bytes: imageBytes('image/png', MIB), contentType: 'image/png' })
    expect(r.status, r.text).toBe(200)
  })
})

test('a Member can\'t read, replace or remove another Member\'s photo', async ({ request }) => {
  const danaId = (await me(request, dana)).memberId
  const leoId = (await me(request, leo)).memberId
  const mine = imageBytes('image/png', 120)
  expect((await call(request, dana, 'PUT', '/api/photo', { bytes: mine, contentType: 'image/png' })).status).toBe(200)
  // Leo's upload and removal act on Leo only.
  const theirs = imageBytes('image/jpeg', 80)
  const put = await call(request, leo, 'PUT', '/api/photo', { bytes: theirs, contentType: 'image/jpeg' })
  expect(put.json).toEqual({ photoUrl: `/api/members/${leoId}/photo`, rev: await revOf(request, leoId) })
  expect((await call(request, dana, 'GET', `/api/members/${danaId}/photo`)).bytes.equals(mine)).toBe(true)
  expect((await call(request, leo, 'DELETE', '/api/photo')).json).toEqual({ photoUrl: null, rev: await revOf(request, leoId) })
  const still = await call(request, dana, 'GET', `/api/members/${danaId}/photo`)
  expect(still.status).toBe(200)
  expect(still.bytes.equals(mine)).toBe(true)
  expect((await call(request, dana, 'GET', `/api/members/${leoId}/photo`)).status, 'Leo\'s was removed').toBe(404)
  // There is no route that names another member in a write.
  for (const method of ['PUT', 'DELETE']) expectError(await call(request, leo, method, `/api/members/${danaId}/photo`, method === 'PUT' ? { bytes: theirs, contentType: 'image/jpeg' } : {}), 404, 'not_found')
  expect((await call(request, dana, 'GET', `/api/members/${danaId}/photo`)).bytes.equals(mine)).toBe(true)
})

test('removing a photo clears it, for everyone', async ({ request }) => {
  const id = (await me(request, dana)).memberId
  await call(request, dana, 'PUT', '/api/photo', { bytes: imageBytes('image/png'), contentType: 'image/png' })
  const del = await call(request, dana, 'DELETE', '/api/photo')
  expect(del.status, del.text).toBe(200)
  expect(del.json).toEqual({ photoUrl: null, rev: await revOf(request, id) })
  expect((await me(request, dana)).photoUrl).toBeNull()
  expectError(await call(request, leo, 'GET', `/api/members/${id}/photo`), 404, 'not_found')
})

test('the download is refused to a principal the row doesn\'t allow, and to the Inhouse team without a grant', async ({ request }) => {
  const id = (await me(request, dana)).memberId
  await call(request, dana, 'PUT', '/api/photo', { bytes: imageBytes('image/png'), contentType: 'image/png' })
  const url = `/api/members/${id}/photo`
  for (const who of ['smoke', 'monitor'] as const) expectError(await call(request, actor(who), 'GET', url), 403, 'forbidden')
  expectError(await call(request, actor('inhouse'), 'GET', url), 403, 'forbidden', 'grant_required')
  // The upload and removal are the owner's only: the Inhouse team, `smoke` and `monitor` can't.
  for (const who of ['inhouse', 'smoke', 'monitor'] as const) {
    expectError(await call(request, actor(who), 'PUT', '/api/photo', { bytes: imageBytes('image/png'), contentType: 'image/png' }), 403, 'forbidden')
    expectError(await call(request, actor(who), 'DELETE', '/api/photo'), 403, 'forbidden')
  }
  // Under a live grant the Inhouse team reads it, and a line says so.
  const made = await call(request, actor('admin'), 'POST', '/api/grants', { json: { hours: 1 } })
  expect(made.status, made.text).toBe(201)
  try {
    const got = await call(request, actor('inhouse'), 'GET', url)
    expect(got.status, got.text).toBe(200)
    expect(got.headers['content-type']).toBe('image/png')
    expect(got.headers['x-content-type-options']).toBe('nosniff')
  } finally {
    await endLiveGrants(request)
  }
  expectError(await call(request, actor('inhouse'), 'GET', url), 403, 'forbidden', 'grant_required')
})
