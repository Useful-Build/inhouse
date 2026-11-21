// Chats (p3-design section 3, routes 22 to 28 and 49). These need no container: a chat is made and changed through the API
// alone, so they run on the local test build and on a deployed one. Oracles: BD11 (a chat is its owner's; another member's id,
// the Admin's included, is 404 before the object check), design section 3's route notes (23 idempotent for its owner, 27 and 28
// take 1 to 50 of the caller's own chats and change nothing when any id isn't theirs, `ifRev` guards 25 and 26 with a 409 that
// carries the chat as it is now), keyset paging newest first, and Inhouse reading only under a live grant.
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { actor, call, endLiveGrants, expectConflict, expectError } from './kit.ts'
import { createChat, newChatId } from './chat-kit.ts'

const dana = actor('memberA')
const leo = actor('memberB')
const admin = actor('admin')
const inhouse = actor('inhouse')
test.describe.configure({ mode: 'serial' })

const ids = (page: { items: { id: string }[] }) => page.items.map(c => c.id)
const list = async (request: APIRequestContext, who: typeof dana, q = '') => {
  const r = await call(request, who, 'GET', `/api/chats${q}`)
  expect(r.status, r.text).toBe(200)
  return r.json as { items: { id: string; title: string; customTitle: string | null; pinned: boolean; deleted: boolean; rev: number; running: boolean }[]; nextCursor: string | null }
}
const get = (request: APIRequestContext, who: typeof dana, id: string) => call(request, who, 'GET', `/api/chats/${id}`)

test.beforeAll(async ({ request }) => { await endLiveGrants(request) })
test.afterAll(async ({ request }) => { await endLiveGrants(request) })

test('POST /api/chats is idempotent for its owner, and another member\'s id is 404', async ({ request }) => {
  const id = newChatId()
  const first = await call(request, dana, 'POST', '/api/chats', { json: { id, title: 'Spec chat' } })
  expect(first.status, first.text).toBe(200)
  expect(first.json).toMatchObject({ id, title: 'Spec chat', customTitle: null, pinned: false, deleted: false, running: false, rev: 1 })
  const again = await call(request, dana, 'POST', '/api/chats', { json: { id, title: 'Spec chat' } })
  expect(again.status, again.text).toBe(200)
  expect(again.json).toEqual(first.json)
  expect(ids(await list(request, dana)).filter(x => x === id)).toEqual([id])
  for (const other of [leo, admin]) expectError(await call(request, other, 'POST', '/api/chats', { json: { id, title: 'Mine now' } }), 404, 'not_found')
  expect((await get(request, dana, id)).json.chat.title).toBe('Spec chat')
})

test('a chat is its owner\'s: lists and reads show nobody else\'s, the Admin\'s included', async ({ request }) => {
  const id = await createChat(request, dana)
  expect(ids(await list(request, dana))).toContain(id)
  for (const other of [leo, admin]) {
    expect(ids(await list(request, other))).not.toContain(id)
    expectError(await get(request, other, id), 404, 'not_found')
  }
  const own = await get(request, dana, id)
  expect(own.status, own.text).toBe(200)
  expect(own.json).toMatchObject({ chat: { id }, messages: [], nextCursor: null, runs: [] })
})

test('Inhouse reads a chat only under a live grant', async ({ request }) => {
  const id = await createChat(request, dana)
  expectError(await get(request, inhouse, id), 403, 'forbidden', 'grant_required')
  expectError(await call(request, inhouse, 'GET', '/api/chats'), 403, 'forbidden', 'grant_required')
  const grant = await call(request, admin, 'POST', '/api/grants', { json: { hours: 1 } })
  expect(grant.status, grant.text).toBe(201)
  const read = await get(request, inhouse, id)
  expect(read.status, read.text).toBe(200)
  expect(read.json.chat.id).toBe(id)
  expect(ids(await list(request, inhouse))).toContain(id)
  await endLiveGrants(request)
  expectError(await get(request, inhouse, id), 403, 'forbidden', 'grant_required')
})

test('rename and pin are guarded by ifRev: a stale rev is a 409 carrying the chat as it is now', async ({ request }) => {
  const id = await createChat(request, dana, newChatId(), 'First title')
  const renamed = await call(request, dana, 'PUT', `/api/chats/${id}/title`, { json: { title: 'Renamed', ifRev: 1 } })
  expect(renamed.status, renamed.text).toBe(200)
  expect(renamed.json).toMatchObject({ id, customTitle: 'Renamed', title: 'Renamed', rev: 2 })
  const stale = expectConflict(await call(request, dana, 'PUT', `/api/chats/${id}/title`, { json: { title: 'Lost', ifRev: 1 } }))
  expect(stale).toMatchObject({ id, customTitle: 'Renamed', rev: 2 })
  const pinned = await call(request, dana, 'PUT', `/api/chats/${id}/pin`, { json: { pinned: true, ifRev: 2 } })
  expect(pinned.status, pinned.text).toBe(200)
  expect(pinned.json).toMatchObject({ id, pinned: true, rev: 3 })
  expectConflict(await call(request, dana, 'PUT', `/api/chats/${id}/pin`, { json: { pinned: false, ifRev: 2 } }))
  const cleared = await call(request, dana, 'PUT', `/api/chats/${id}/title`, { json: { title: null, ifRev: 3 } })
  expect(cleared.status, cleared.text).toBe(200)
  expect(cleared.json).toMatchObject({ id, customTitle: null, pinned: true, rev: 4 })
  // Another member's chat is 404, for both writes, whatever rev they send.
  for (const other of [leo, admin]) {
    expectError(await call(request, other, 'PUT', `/api/chats/${id}/title`, { json: { title: 'Mine', ifRev: 4 } }), 404, 'not_found')
    expectError(await call(request, other, 'PUT', `/api/chats/${id}/pin`, { json: { pinned: false, ifRev: 4 } }), 404, 'not_found')
  }
  for (const bad of [{ title: '', ifRev: 4 }, { title: 'x', ifRev: 0 }, { title: 'x' }, { title: 'x', ifRev: 4, extra: 1 }]) {
    expect((await call(request, dana, 'PUT', `/api/chats/${id}/title`, { json: bad })).status, JSON.stringify(bad)).toBe(400)
  }
})

test('delete and restore take 1 to 50 of the caller\'s own chats, all or nothing', async ({ request }) => {
  const [a, b] = [await createChat(request, dana), await createChat(request, dana)]
  const foreign = await createChat(request, leo)
  // One id that isn't theirs: 404 and nothing changes.
  expectError(await call(request, dana, 'POST', '/api/chats/delete', { json: { ids: [a, foreign] } }), 404, 'not_found')
  expect(ids(await list(request, dana))).toContain(a)
  expect(ids(await list(request, leo))).toContain(foreign)
  expectError(await call(request, dana, 'POST', '/api/chats/delete', { json: { ids: [a, newChatId()] } }), 404, 'not_found')
  const del = await call(request, dana, 'POST', '/api/chats/delete', { json: { ids: [a, b] } })
  expect(del.status, del.text).toBe(200)
  expect(ids(del.json).sort()).toEqual([a, b].sort())
  expect(del.json.items.every((c: { deleted: boolean }) => c.deleted)).toBe(true)
  expect(ids(await list(request, dana))).not.toContain(a)
  expect(ids(await list(request, dana, '?deleted=true'))).toEqual(expect.arrayContaining([a, b]))
  const back = await call(request, dana, 'POST', '/api/chats/restore', { json: { ids: [a] } })
  expect(back.status, back.text).toBe(200)
  expect(back.json.items[0]).toMatchObject({ id: a, deleted: false })
  expect(ids(await list(request, dana))).toContain(a)
  expect(ids(await list(request, dana))).not.toContain(b)
  expectError(await call(request, leo, 'POST', '/api/chats/restore', { json: { ids: [b] } }), 404, 'not_found')
  // The size rule: 0 and 51 ids are 400.
  expect((await call(request, dana, 'POST', '/api/chats/delete', { json: { ids: [] } })).status).toBe(400)
  expect((await call(request, dana, 'POST', '/api/chats/delete', { json: { ids: Array.from({ length: 51 }, newChatId) } })).status).toBe(400)
  expect(ids(await list(request, leo))).toContain(foreign)
})

test('the list pages newest first by keyset, with no repeat and no gap', async ({ request }) => {
  const made: string[] = []
  for (let i = 0; i < 3; i++) made.push(await createChat(request, leo))
  // Nothing is newer than the three just made (the specs run one at a time), so they are the head of Leo's list, newest first.
  const first = await list(request, leo, '?limit=2')
  expect(ids(first)).toEqual([made[2], made[1]])
  expect(first.nextCursor).not.toBeNull()
  const second = await list(request, leo, `?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`)
  expect(second.items[0]!.id).toBe(made[0])
  expect(ids(second)).not.toContain(made[1])
  expect((await call(request, leo, 'GET', '/api/chats?limit=0')).status).toBe(400)
  expect((await call(request, leo, 'GET', '/api/chats?limit=101')).status).toBe(400)
  expect((await call(request, leo, 'GET', '/api/chats?cursor=not-a-cursor')).status).toBe(400)
})

test('the session reset (49) is the owner\'s: another member\'s chat is 404, and an idle chat resets', async ({ request }) => {
  const id = await createChat(request, dana)
  for (const other of [leo, admin]) expectError(await call(request, other, 'POST', `/api/chats/${id}/session/reset`, { json: {} }), 404, 'not_found')
  const own = await call(request, dana, 'POST', `/api/chats/${id}/session/reset`, { json: {} })
  expect(own.status, own.text).toBe(200)
  expect((await get(request, dana, id)).status).toBe(200)
})
