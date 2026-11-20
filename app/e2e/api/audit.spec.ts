// The audit log (p2-design section 8, decision Q3): every write adds one line, by a member id, with no name or email in
// its arguments; a write that changes nothing (a stale `ifRev`, a refusal, a bad body) adds none; the CSV matches the
// page and defuses formula cells; and nothing can edit or delete a line. The stored arguments aren't in any API answer,
// so they're read from the test build's local D1 (db.ts).
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { actor, allPages, call, endLiveGrants, expectConflict, expectError, imageBytes, me, newIdentity, parseCsv, personActor, putSetting, sampleValue, settingRev, someKey } from './kit.ts'
import { auditMax, expectOneLine, readSql, writeSql } from './db.ts'
import type { AuditRow } from './db.ts'

const admin = actor('admin')
const dana = actor('memberA')
const alex = actor('inhouse')
test.describe.configure({ mode: 'serial' })
test.beforeAll(async ({ request }) => {
  await endLiveGrants(request)
  // Any grant expiry not yet logged is written by the first audit read; flush it so no test sees it as a stray line.
  await call(request, admin, 'GET', '/api/audit')
})

interface Line { id: number; at: { iso: string; ms: number }; actorId: string; who: string; what: string; detail: string }
const pages = async (request: APIRequestContext) => (await allPages<Line>(request, admin, '/api/audit', 100)).items

test('every kind of write adds one line, by a member id, with no name or email in it', async ({ request }) => {
  const adminId = (await me(request, admin)).memberId
  const danaMe = await me(request, dana)
  const alexId = (await me(request, alex)).memberId
  const who = newIdentity('audit')

  let mark = auditMax()
  const invited = await call(request, admin, 'POST', '/api/members/invites', { json: { name: who.name, email: who.email, title: 'Auditor', role: 'member' } })
  expect(invited.status, invited.text).toBe(201)
  const inviteLine = expectOneLine(mark, 'member.invited', adminId, [who.name, 'Auditor'])
  expect(JSON.parse(inviteLine.args_json)).toMatchObject({ memberId: invited.json.id, role: 'member' })

  mark = auditMax()
  expect((await me(request, personActor(who))).memberId).toBe(invited.json.id)
  expectOneLine(mark, 'member.bound', invited.json.id, [who.name])

  const bound = (await allPages<{ id: string; rev: number }>(request, admin, '/api/members', 100)).items.find(m => m.id === invited.json.id)
  expect(bound, 'the bound member is listed').toBeTruthy()
  mark = auditMax()
  const promoted = await call(request, admin, 'PUT', `/api/members/${invited.json.id}/role`, { json: { role: 'admin', ifRev: bound?.rev } })
  expect(promoted.status, promoted.text).toBe(200)
  expect(JSON.parse(expectOneLine(mark, 'member.role_changed', adminId, [who.name]).args_json)).toMatchObject({ memberId: invited.json.id, from: 'member', to: 'admin' })

  mark = auditMax()
  const removed = await call(request, admin, 'DELETE', `/api/members/${invited.json.id}?ifRev=${promoted.json.rev}`)
  expect(removed.status, removed.text).toBe(200)
  expectOneLine(mark, 'member.removed', adminId, [who.name])

  // A personal switch: kept as it is (a boolean, audit-safe).
  const switchKey = someKey('personal', 'bool')
  mark = auditMax()
  expect((await putSetting(request, dana, 'personal', switchKey, false)).status).toBe(200)
  expect(JSON.parse(expectOneLine(mark, 'setting.changed', danaMe.memberId).args_json)).toMatchObject({ scope: 'personal', key: switchKey, value: false })

  // A personal name (about `g:name` itself, so the literal) and a free-text key: only their length and hash are kept.
  const secretText = `Audit Rename ${crypto.randomUUID().slice(0, 8)}`
  const original = (await call(request, dana, 'GET', '/api/me')).json.name as string
  mark = auditMax()
  expect((await putSetting(request, dana, 'personal', 'g:name', secretText)).status).toBe(200)
  try {
    const nameLine = expectOneLine(mark, 'setting.changed', danaMe.memberId, [secretText, original])
    const args = JSON.parse(nameLine.args_json)
    expect(args).toMatchObject({ scope: 'personal', key: 'g:name', redacted: { len: secretText.length } })
    expect(args.redacted.hash).toMatch(/^[0-9a-f]{32}$/)
    expect('value' in args, 'a redacted value is not also kept').toBe(false)
  } finally {
    expect((await putSetting(request, dana, 'personal', 'g:name', original)).status).toBe(200)
  }
  const textKey = someKey('personal', 'redacted')
  const text = 'Audit free text'
  mark = auditMax()
  expect((await putSetting(request, dana, 'personal', textKey, text)).status).toBe(200)
  expect(JSON.parse(expectOneLine(mark, 'setting.changed', danaMe.memberId, [text]).args_json).redacted).toMatchObject({ len: text.length })

  const brandKey = someKey('brand', 'enum')
  const brandValue = sampleValue(brandKey, 1)
  mark = auditMax()
  expect((await putSetting(request, admin, 'brand', brandKey, brandValue)).status).toBe(200)
  expect(JSON.parse(expectOneLine(mark, 'setting.changed', adminId).args_json)).toMatchObject({ scope: 'brand', key: brandKey, value: brandValue })

  const techKey = someKey('technical', 'redacted')
  const techText = 'Signed, Audit Team'
  mark = auditMax()
  expect((await putSetting(request, alex, 'technical', techKey, techText)).status).toBe(200)
  expect(JSON.parse(expectOneLine(mark, 'setting.changed', alexId, [techText]).args_json)).toMatchObject({ scope: 'technical', key: techKey, redacted: { len: techText.length } })

  mark = auditMax()
  expect((await call(request, dana, 'PUT', '/api/photo', { bytes: imageBytes('image/png'), contentType: 'image/png' })).status).toBe(200)
  expect(JSON.parse(expectOneLine(mark, 'photo.changed', danaMe.memberId).args_json)).toMatchObject({ type: 'image/png', size: 64 })
  mark = auditMax()
  expect((await call(request, dana, 'DELETE', '/api/photo')).status).toBe(200)
  expectOneLine(mark, 'photo.removed', danaMe.memberId)

  mark = auditMax()
  const grant = await call(request, admin, 'POST', '/api/grants', { json: { hours: 1 } })
  expect(grant.status, grant.text).toBe(201)
  expectOneLine(mark, 'grant.created', adminId)
  mark = auditMax()
  expect((await call(request, admin, 'POST', `/api/grants/${grant.json.id}/end`, { json: { ifRev: grant.json.rev } })).status).toBe(200)
  expectOneLine(mark, 'grant.ended', adminId)
})

test('a write refused or changing nothing leaves no line: a stale ifRev, a bad body, a refusal, a removed photo twice', async ({ request }) => {
  const mark = auditMax()
  const key = someKey('personal', 'bool')
  const rev = await settingRev(request, dana, 'personal', key)
  const first = await call(request, dana, 'PUT', `/api/settings/personal/${encodeURIComponent(key)}`, { json: { value: true, ifRev: rev } })
  expect(first.status, first.text).toBe(200)
  const afterFirst = auditMax()
  expect(afterFirst, 'the first write added its line').toBe(mark + 1)

  // The same ifRev again is stale now.
  const stale = await call(request, dana, 'PUT', `/api/settings/personal/${encodeURIComponent(key)}`, { json: { value: false, ifRev: rev } })
  expect(stale.status).toBe(409)
  expect(stale.json.error.current).toMatchObject({ key, value: true, rev: rev + 1 })
  // Stale on a brand setting and a member's role.
  const brandKey = someKey('brand', 'bool')
  const brandRev = await settingRev(request, admin, 'brand', brandKey)
  expect((await call(request, admin, 'PUT', `/api/settings/brand/${encodeURIComponent(brandKey)}`, { json: { value: true, ifRev: brandRev + 3 } })).status).toBe(409)
  expect((await call(request, admin, 'PUT', '/api/members/m_e2e_nobody/role', { json: { role: 'admin', ifRev: 1 } })).status).toBe(404)
  // A bad value, a missing ifRev, a body that isn't JSON, a key of another scope.
  expectError(await call(request, dana, 'PUT', `/api/settings/personal/${encodeURIComponent(key)}`, { json: { value: 'yes', ifRev: rev + 1 } }), 400, 'invalid')
  expectError(await call(request, dana, 'PUT', `/api/settings/personal/${encodeURIComponent(key)}`, { json: { value: true } }), 400, 'invalid')
  expectError(await call(request, dana, 'PUT', `/api/settings/personal/${encodeURIComponent(key)}`, { bytes: Buffer.from('nope'), contentType: 'application/json' }), 400, 'invalid')
  expectError(await call(request, dana, 'PUT', '/api/settings/personal/stage', { json: { value: 'Act', ifRev: 0 } }), 404, 'not_found', 'wrong_scope')
  // A refusal by role or by owner.
  expectError(await call(request, dana, 'PUT', `/api/settings/brand/${encodeURIComponent(brandKey)}`, { json: { value: true, ifRev: brandRev } }), 403, 'forbidden')
  expectError(await call(request, alex, 'PUT', `/api/settings/personal/${encodeURIComponent(key)}`, { json: { value: true, ifRev: 0 } }), 403, 'forbidden')
  // Removing a photo that isn't there changes nothing and logs nothing.
  expect((await call(request, dana, 'DELETE', '/api/photo')).status).toBe(200)
  expect((await call(request, dana, 'DELETE', '/api/photo')).status).toBe(200)
  expect(auditMax(), 'no refused or empty write added a line').toBe(afterFirst)
})

test('a stale ifRev on a role change, a removal and a grant end leaves no line', async ({ request }) => {
  const who = newIdentity('stale')
  const invited = await call(request, admin, 'POST', '/api/members/invites', { json: { name: who.name, email: who.email, role: 'member' } })
  expect(invited.status, invited.text).toBe(201)
  await endLiveGrants(request)
  const grant = await call(request, admin, 'POST', '/api/grants', { json: { hours: 1 } })
  expect(grant.status, grant.text).toBe(201)
  try {
    const mark = auditMax()
    expectConflict(await call(request, admin, 'PUT', `/api/members/${invited.json.id}/role`, { json: { role: 'admin', ifRev: invited.json.rev + 20 } }))
    expectConflict(await call(request, admin, 'DELETE', `/api/members/${invited.json.id}?ifRev=${invited.json.rev + 20}`))
    expectConflict(await call(request, admin, 'POST', `/api/grants/${grant.json.id}/end`, { json: { ifRev: grant.json.rev + 20 } }))
    expect(auditMax(), 'no stale write added a line').toBe(mark)
  } finally {
    await endLiveGrants(request)
  }
})

test('the CSV is the page: the same lines in the same order, every cell quoted', async ({ request }) => {
  const page = await pages(request)
  expect(page.length).toBeGreaterThan(10)
  const res = await call(request, admin, 'GET', '/api/audit/export.csv')
  expect(res.status, res.text).toBe(200)
  expect(res.headers['content-type']).toBe('text/csv; charset=utf-8')
  expect(res.headers['content-disposition']).toMatch(/^attachment; filename=/)
  expect(res.headers['x-content-type-options']).toBe('nosniff')
  const rows = parseCsv(res.text)
  expect(rows[0]).toEqual(['When', 'Who', 'What', 'Detail'])
  expect(rows.slice(1)).toEqual(page.map(l => [l.at.iso, l.who, l.what, l.detail].map(defuse)))
  expect(res.text.split('\r\n').filter(Boolean).every(row => row.startsWith('"') && row.endsWith('"')), 'every cell is quoted').toBe(true)
  // Newest first by id.
  expect(page.map(l => l.id)).toEqual([...page.map(l => l.id)].sort((a, b) => b - a))
})

/** A cell as the export must write it (OWASP, CSV injection): a formula start gets a leading apostrophe. */
const defuse = (cell: string) => (/^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell)

test('the CSV defuses cells that start with =, +, -, @, a tab or a carriage return, and doubles quotes', async ({ request }) => {
  const names = ['=SUM(1+1)', '+1 plus', '-2 minus', '@handle', '"quoted" name']
  const ids: string[] = []
  for (const name of names) {
    const who = newIdentity('csv')
    const r = await call(request, admin, 'POST', '/api/members/invites', { json: { name, email: who.email, role: 'member' } })
    expect(r.status, r.text).toBe(201)
    ids.push(r.json.id)
  }
  // The API trims a name, so a leading tab or carriage return can only be put in the stored row directly.
  const tab = newIdentity('csv')
  const cr = newIdentity('csv')
  const tabId = (await call(request, admin, 'POST', '/api/members/invites', { json: { name: 'Tab name', email: tab.email, role: 'member' } })).json.id as string
  const crId = (await call(request, admin, 'POST', '/api/members/invites', { json: { name: 'CR name', email: cr.email, role: 'member' } })).json.id as string
  writeSql("UPDATE members SET name = char(9) || 'Tab name' WHERE id = ?", tabId)
  writeSql("UPDATE members SET name = char(13) || 'CR name' WHERE id = ?", crId)
  try {
    const res = await call(request, admin, 'GET', '/api/audit/export.csv')
    expect(res.status).toBe(200)
    const details = parseCsv(res.text).slice(1).map(r => r[3])
    for (const text of ['=SUM(1+1)', '+1 plus', '-2 minus', '@handle', '\tTab name', '\rCR name']) {
      expect(details, text).toContain(`'${text} as Member`)
      expect(details, `${text} unescaped`).not.toContain(`${text} as Member`)
    }
    expect(details).toContain('"quoted" name as Member')
    expect(res.text).toContain('"""quoted"" name as Member"')
  } finally {
    writeSql("UPDATE members SET name = 'Tab name' WHERE id = ?", tabId)
    writeSql("UPDATE members SET name = 'CR name' WHERE id = ?", crId)
  }
})

test('UPDATE and DELETE have no route, and the log refuses both in storage', async ({ request }) => {
  for (const path of ['/api/audit', '/api/audit/1', '/api/audit/export.csv']) {
    for (const method of ['PUT', 'PATCH', 'DELETE', 'POST']) {
      expectError(await call(request, admin, method, path, { json: {} }), 404, 'not_found')
    }
  }
  const mark = auditMax()
  const [line] = readSql<{ id: number }>('SELECT id FROM audit_log ORDER BY id LIMIT 1')
  expect(() => writeSql("UPDATE audit_log SET action = 'setting.changed' WHERE id = ?", line.id)).toThrow(/append-only/)
  expect(() => writeSql('DELETE FROM audit_log WHERE id = ?', line.id)).toThrow(/append-only/)
  expect(auditMax()).toBe(mark)
  expect(readSql('SELECT id FROM audit_log WHERE id = ?', line.id)).toHaveLength(1)
})

test('every stored line names a member as its actor and holds no name or email', async () => {
  const lines = readSql<AuditRow>('SELECT id, actor_id, action, args_json FROM audit_log ORDER BY id')
  const people = new Set(readSql<{ id: string }>('SELECT id FROM members').map(m => m.id))
  const names = readSql<{ name: string }>("SELECT name FROM members WHERE name IS NOT NULL AND length(name) >= 5 AND name NOT LIKE '%Former member%'").map(m => m.name)
  const emails = readSql<{ e: string }>('SELECT email_norm AS e FROM members WHERE email_norm IS NOT NULL').map(m => m.e)
  expect(lines.length).toBeGreaterThan(20)
  for (const l of lines) {
    expect(l.actor_id, `line ${l.id}`).toMatch(/^m_/)
    expect(people.has(l.actor_id), `line ${l.id}'s actor is a member`).toBe(true)
    expect(l.args_json, `line ${l.id}`).not.toMatch(/@|example\.test/)
    for (const name of names) expect(l.args_json, `line ${l.id} holds a member's name`).not.toContain(name)
    for (const email of emails) expect(l.args_json).not.toContain(email)
  }
})
