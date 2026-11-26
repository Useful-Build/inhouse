// Permissions (Stage 1 M2-A, routes 110 and 111; N10, N15). Oracles are the plan's words, written out here: a member
// sees and removes only their own "Always allow" permissions; an admin sees and removes any; the Inhouse team gets none
// (the matrix sweep checks its 403); a stale `ifRev` is 409 with the permission as it is; an id the caller can't see,
// or one already removed, is 404; a removal leaves one `permission.revoked` line that holds ids and codes only. No
// route creates a permission (the outbox's "Always allow" does, M2-B), so the grants are written to the local D1.
// The list shows only current grants (an enabled ceiling at the grant's revision, the account on the grant's
// generation), so the spec also turns the operation on and writes its own connector account, and turns the operation
// off and removes the account after: writes stay off for every other spec (N2). The ceiling is set only through the
// test-fakes hook (its one writer in the test build), never by hand.
import { expect, test } from '@playwright/test'
import { actor, call, expectConflict, me } from './kit.ts'
import { auditMax, expectOneLine, writeSql } from './db.ts'
import { setCeiling } from './fakes-kit.ts'

const dana = actor('memberA')
const leo = actor('memberB')
const admin = actor('admin')
test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).padEnd(10, '0').slice(0, 10)
const idOf = (tag: string) => `pg_e2e${stamp}${tag}`.padEnd(25, 'A').slice(0, 25)
const DANA_GRANT = idOf('dana')
const LEO_GRANT = idOf('leo')
let danaId = ''
let leoId = ''

/** This spec's own connector account, at generation 1: no other spec's account is touched. */
const ACCOUNT = `shopify:e2e-perm-${stamp}`

function grant(id: string, holder: string, scope: string): void {
  writeSql(
    `INSERT INTO permission_grants (id, holder, holder_member, account_id, account_gen, operation, scope_json, scope_key, per_day,
       policy_rev, granted_by, granted_role, ceiling_rev, granted_at_ms)
     VALUES (?, ?, ?, ?, 1, 'shopify.order.tag_add', ?, ?, 50, 1, ?, 'member',
       (SELECT lowered_rev FROM permission_ceiling WHERE operation = 'shopify.order.tag_add'), ?)`,
    id, `member:${holder}`, holder, ACCOUNT, JSON.stringify({ shop: scope }), `shop=${scope}`, holder, Date.now(),
  )
}

test.beforeAll(async ({ request }) => {
  danaId = (await me(request, dana)).memberId
  leoId = (await me(request, leo)).memberId
  writeSql("DELETE FROM permission_grants WHERE id LIKE 'pg_e2e%'")
  writeSql("DELETE FROM connector_accounts WHERE account_id LIKE 'shopify:e2e-perm-%'")
  writeSql("INSERT INTO connector_accounts (account_id, connector, last_state, last_state_at_ms, connected_at_ms) VALUES (?, 'shopify', 'connected', 1, 1)", ACCOUNT)
  await setCeiling(request, 'shopify.order.tag_add', true)
  grant(DANA_GRANT, danaId, `e2e-${stamp}-dana`)
  grant(LEO_GRANT, leoId, `e2e-${stamp}-leo`)
})
test.afterAll(async ({ request }) => {
  await setCeiling(request, 'shopify.order.tag_add', false)
  writeSql("DELETE FROM permission_grants WHERE id LIKE 'pg_e2e%'")
  writeSql('DELETE FROM connector_accounts WHERE account_id = ?', ACCOUNT)
})

const list = async (request: Parameters<typeof call>[0], who: typeof dana): Promise<{ id: string; rev: number; holder: unknown; title: string; scope: string; can: { remove: boolean } }[]> => {
  const r = await call(request, who, 'GET', '/api/permissions')
  expect(r.status, r.text).toBe(200)
  return r.json.items
}

test('a member sees only their own permissions; an admin sees everyone\'s', async ({ request }) => {
  const mine = (await list(request, dana)).filter(p => p.id.startsWith('pg_e2e'))
  expect(mine.map(p => p.id)).toEqual([DANA_GRANT])
  expect(mine[0]).toMatchObject({ holder: { kind: 'member', memberId: danaId }, title: 'Add tags to orders', scope: `e2e-${stamp}-dana`, can: { remove: true } })
  const all = (await list(request, admin)).filter(p => p.id.startsWith('pg_e2e')).map(p => p.id).sort()
  expect(all).toEqual([DANA_GRANT, LEO_GRANT].sort())
})

test('a member can\'t remove someone else\'s permission: 404, and nothing changes', async ({ request }) => {
  const mark = auditMax()
  const r = await call(request, dana, 'POST', `/api/permissions/${LEO_GRANT}/remove`, { json: { ifRev: 1 } })
  expect(r.status, r.text).toBe(404)
  expect((await list(request, leo)).map(p => p.id)).toContain(LEO_GRANT)
  expect(auditMax()).toBe(mark)
})

test('a stale ifRev is 409 with the permission as it is; the right one removes it with one line', async ({ request }) => {
  const stale = await call(request, dana, 'POST', `/api/permissions/${DANA_GRANT}/remove`, { json: { ifRev: 5 } })
  expect(expectConflict(stale)).toMatchObject({ id: DANA_GRANT, rev: 1 })
  const mark = auditMax()
  const done = await call(request, dana, 'POST', `/api/permissions/${DANA_GRANT}/remove`, { json: { ifRev: 1 } })
  expect(done.status, done.text).toBe(200)
  expect(done.json.items.map((p: { id: string }) => p.id)).not.toContain(DANA_GRANT)
  const line = expectOneLine(mark, 'permission.revoked', danaId)
  expect(JSON.parse(line.args_json)).toEqual({ permissionId: DANA_GRANT, operation: 'shopify.order.tag_add', reason: 'removed' })
  const again = await call(request, dana, 'POST', `/api/permissions/${DANA_GRANT}/remove`, { json: { ifRev: 2 } })
  expect(again.status, again.text).toBe(404)
})

test('an admin removes a member\'s permission', async ({ request }) => {
  const mark = auditMax()
  const adminId = (await me(request, admin)).memberId
  const done = await call(request, admin, 'POST', `/api/permissions/${LEO_GRANT}/remove`, { json: { ifRev: 1 } })
  expect(done.status, done.text).toBe(200)
  expectOneLine(mark, 'permission.revoked', adminId)
  expect((await list(request, leo)).map(p => p.id)).not.toContain(LEO_GRANT)
})
