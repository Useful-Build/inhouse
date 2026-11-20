// Members (p2-design section 7): invite, first sign-in binding, an uninvited identity, removal, re-invite (the same
// subject gets its id back, another subject a new one) and the last-Admin rule. Every test makes its own people
// (newIdentity), so nothing here depends on, or changes, the seeded team.
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { actor, allPages, call, expectConflict, expectError, me, newIdentity, personActor } from './kit.ts'
import type { Actor } from './kit.ts'
import { auditMax, expectOneLine } from './db.ts'

const admin = actor('admin')
test.describe.configure({ mode: 'serial' })

interface Member { id: string; name: string; email: string | null; title: string | null; role: string; status: string; rev: number }

const members = async (request: APIRequestContext) => (await allPages<Member>(request, admin, '/api/members', 100)).items
const find = async (request: APIRequestContext, id: string) => {
  const found = (await members(request)).find(m => m.id === id)
  expect(found, `member ${id} is listed`).toBeTruthy()
  return found as Member
}

async function invite(request: APIRequestContext, i: { name: string; email: string }, role: 'member' | 'admin' = 'member', title?: string) {
  const r = await call(request, admin, 'POST', '/api/members/invites', { json: { name: i.name, email: i.email, role, ...(title ? { title } : {}) } })
  expect(r.status, r.text).toBe(201)
  return r.json as Member
}

async function remove(request: APIRequestContext, id: string) {
  const m = await find(request, id)
  const r = await call(request, admin, 'DELETE', `/api/members/${id}?ifRev=${m.rev}`)
  expect(r.status, r.text).toBe(200)
  return r.json as Member
}

test('an invite is 201 with the invited member, and a second invite for the email is 409 already_member', async ({ request }) => {
  const who = newIdentity('invite')
  const invited = await invite(request, who, 'member', 'Tester')
  expect(invited).toMatchObject({ name: who.name, email: who.email, title: 'Tester', role: 'member', status: 'invited', rev: 1 })
  expect(invited.id).toMatch(/^m_/)
  expect(await find(request, invited.id)).toMatchObject({ status: 'invited' })
  for (const email of [who.email, who.email.toUpperCase()]) {
    expectError(await call(request, admin, 'POST', '/api/members/invites', { json: { name: 'Again', email, role: 'member' } }), 409, 'conflict', 'already_member')
  }
  // An email with spaces around it is not an email: 400, not a match for the open row.
  expectError(await call(request, admin, 'POST', '/api/members/invites', { json: { name: 'Padded', email: ` ${who.email} `, role: 'member' } }), 400, 'invalid')
  // Bad bodies are 400.
  for (const json of [{}, { name: '', email: who.email, role: 'member' }, { name: 'X', email: 'not-an-email', role: 'member' }, { name: 'X', email: 'x@example.test', role: 'inhouse' }, { name: 'X', email: 'x@example.test', role: 'member', extra: 1 }]) {
    expectError(await call(request, admin, 'POST', '/api/members/invites', { json }), 400, 'invalid')
  }
})

test('the first sign-in binds the invite and lands as a Member with the invited name', async ({ request }) => {
  const who = newIdentity('bind')
  const invited = await invite(request, who, 'member', 'Binder')
  const mark = auditMax()
  const signedIn = await me(request, personActor(who))
  expectOneLine(mark, 'member.bound', invited.id, [who.name])
  expect(signedIn).toMatchObject({ memberId: invited.id, name: who.name, email: who.email, role: 'member', grant: null })
  expect(signedIn.can).toMatchObject({ invite: false, changeRole: false, remove: false, grantSupport: false })
  expect(await find(request, invited.id)).toMatchObject({ status: 'active', role: 'member', name: who.name })
  // Signing in again is the same member: no second row, no second bind.
  expect((await me(request, personActor(who))).memberId).toBe(invited.id)
  expect((await members(request)).filter(m => m.email === who.email)).toHaveLength(1)
})

test('an invited Admin lands as an Admin', async ({ request }) => {
  const who = newIdentity('admin')
  const invited = await invite(request, who, 'admin')
  try {
    const signedIn = await me(request, personActor(who))
    expect(signedIn).toMatchObject({ memberId: invited.id, role: 'admin' })
    expect(signedIn.can).toMatchObject({ invite: true, changeRole: true, remove: true, grantSupport: true })
  } finally {
    await remove(request, invited.id)
  }
})

test('an Inhouse person\'s first sign-in makes one member row and one inhouse.first_sign_in line, and a second adds none', async ({ request }) => {
  const who = newIdentity('inhouse')
  const mark = auditMax()
  const first = await me(request, personActor(who, 'inhouse'))
  expect(first.role).toBe('inhouse')
  expectOneLine(mark, 'inhouse.first_sign_in', first.memberId, [who.email])
  const again = auditMax()
  expect((await me(request, personActor(who, 'inhouse'))).memberId).toBe(first.memberId)
  expect(auditMax()).toBe(again)
})

test('an uninvited identity is 403 not_invited, on any route, and makes no member', async ({ request }) => {
  const who = newIdentity('stranger')
  const before = (await members(request)).length
  for (const path of ['/api/me', '/api/members', '/api/settings/brand']) expectError(await call(request, personActor(who), 'GET', path), 403, 'forbidden', 'not_invited')
  expect(await members(request)).toHaveLength(before)
})

test('a removed member\'s next request is 403 removed, and the row and id stay', async ({ request }) => {
  const who = newIdentity('removed')
  const invited = await invite(request, who)
  expect((await me(request, personActor(who))).memberId).toBe(invited.id)
  const gone = await remove(request, invited.id)
  expect(gone).toMatchObject({ id: invited.id, status: 'removed' })
  for (const path of ['/api/me', '/api/members']) expectError(await call(request, personActor(who), 'GET', path), 403, 'forbidden', 'removed')
  expect(await find(request, invited.id)).toMatchObject({ status: 'removed' })
})

test('a re-invite restores the same id for the same subject, and gives a different subject a new id', async ({ request }) => {
  const who = newIdentity('reinvite')
  const first = await invite(request, who, 'member', 'First')
  expect((await me(request, personActor(who))).memberId).toBe(first.id)
  await remove(request, first.id)
  expectError(await call(request, personActor(who), 'GET', '/api/me'), 403, 'forbidden', 'removed')

  // The same email invited again: the removed row is invited again (same id), with the new role and title.
  const adminId = (await me(request, admin)).memberId
  let mark = auditMax()
  const again = await invite(request, { name: `${who.name} again`, email: who.email }, 'admin', 'Second')
  expect(again).toMatchObject({ id: first.id, status: 'invited', role: 'admin' })
  expectOneLine(mark, 'member.reinvited', adminId, [who.name])
  // Signing in as the same subject restores that row.
  mark = auditMax()
  const restored = await me(request, personActor(who))
  expect(restored).toMatchObject({ memberId: first.id, role: 'admin', name: `${who.name} again` })
  expectOneLine(mark, 'member.restored', first.id, [who.name])
  mark = auditMax()
  await me(request, personActor(who))
  expect(auditMax(), 'a second sign-in writes nothing').toBe(mark)
  await remove(request, first.id)

  // Invited once more, and a different subject signs in with the email: a new member, the old id stays removed.
  await invite(request, { name: `${who.name} third`, email: who.email }, 'member')
  const other = { ...who, sub: `${who.sub}-new` }
  mark = auditMax()
  const fresh = await me(request, personActor(other))
  expect(fresh.memberId).not.toBe(first.id)
  expect(JSON.parse(expectOneLine(mark, 'member.bound', fresh.memberId, [who.name]).args_json)).toMatchObject({ memberId: fresh.memberId, replaces: first.id })
  expect(fresh).toMatchObject({ role: 'member', name: `${who.name} third` })
  expect(await find(request, first.id)).toMatchObject({ status: 'removed' })
  expect(await find(request, fresh.memberId)).toMatchObject({ status: 'active' })
  // The old subject never gets the new id's access: it was removed.
  expectError(await call(request, personActor(who), 'GET', '/api/me'), 403, 'forbidden', 'removed')
  await remove(request, fresh.memberId)
})

test('the last Admin can\'t be demoted or removed (409 last_admin), and a second Admin lifts the rule', async ({ request }) => {
  const adminId = (await me(request, admin)).memberId
  const rows = await members(request)
  expect(rows.filter(m => m.role === 'admin' && m.status === 'active').map(m => m.id), 'a spec left another Admin behind').toEqual([adminId])
  const self = rows.find(m => m.id === adminId) as Member

  expectError(await call(request, admin, 'PUT', `/api/members/${adminId}/role`, { json: { role: 'member', ifRev: self.rev } }), 409, 'conflict', 'last_admin')
  expectError(await call(request, admin, 'DELETE', `/api/members/${adminId}?ifRev=${self.rev}`), 409, 'conflict', 'last_admin')
  expect((await me(request, admin)).role, 'still an Admin').toBe('admin')

  const who = newIdentity('second-admin')
  const invited = await invite(request, who, 'admin')
  const second: Actor = personActor(who)
  try {
    await me(request, second)
    const bound = await find(request, invited.id)
    // Now Sam is not the last Admin: demoting works, and the other Admin is then the last.
    const demoted = await call(request, admin, 'PUT', `/api/members/${adminId}/role`, { json: { role: 'member', ifRev: (await find(request, adminId)).rev } })
    expect(demoted.status, demoted.text).toBe(200)
    expect(demoted.json.role).toBe('member')
    expectError(await call(request, second, 'PUT', `/api/members/${invited.id}/role`, { json: { role: 'member', ifRev: bound.rev } }), 409, 'conflict', 'last_admin')
    // Put Sam back (the second Admin does it) so the team is as it was.
    const restored = await call(request, second, 'PUT', `/api/members/${adminId}/role`, { json: { role: 'admin', ifRev: demoted.json.rev } })
    expect(restored.status, restored.text).toBe(200)
  } finally {
    // Whatever failed above, the team ends with Sam as its Admin and the second Admin removed.
    const sam = await find(request, adminId)
    if (sam.role !== 'admin') await call(request, second, 'PUT', `/api/members/${adminId}/role`, { json: { role: 'admin', ifRev: sam.rev } })
    await remove(request, invited.id)
  }
  expect((await members(request)).filter(m => m.role === 'admin' && m.status === 'active').map(m => m.id)).toEqual([adminId])
})

test('a role change and a removal need their rev, and a stale one is 409 with the member as it is now', async ({ request }) => {
  const who = newIdentity('revs')
  const invited = await invite(request, who)
  const mark = auditMax()
  expectError(await call(request, admin, 'PUT', `/api/members/${invited.id}/role`, { json: { role: 'admin' } }), 400, 'invalid')
  expectError(await call(request, admin, 'DELETE', `/api/members/${invited.id}`), 400, 'invalid')
  const stale = await call(request, admin, 'PUT', `/api/members/${invited.id}/role`, { json: { role: 'admin', ifRev: invited.rev + 7 } })
  expect(expectConflict(stale)).toMatchObject({ id: invited.id, role: 'member', rev: invited.rev })
  const staleRemove = await call(request, admin, 'DELETE', `/api/members/${invited.id}?ifRev=${invited.rev + 7}`)
  expect(expectConflict(staleRemove)).toMatchObject({ id: invited.id, status: 'invited' })
  // Unknown members are 404.
  expectError(await call(request, admin, 'PUT', '/api/members/m_e2e_nobody/role', { json: { role: 'admin', ifRev: 1 } }), 404, 'not_found')
  expect(auditMax(), 'no refused write added a line').toBe(mark)
  await me(request, personActor(who))
  await remove(request, invited.id)
})
