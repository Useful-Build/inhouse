// A grant past its end (p2-design section 9): not live, and its `grant.expired` line is written once, by the system, by
// the first request that reads grants or the audit log. This file's name sorts first, so it runs before any other spec has
// made such a read (the files run serially, in name order): the grant must still be unlogged, and the Inhouse team must
// already be refused, because access never depends on the flag.
import { expect, test } from '@playwright/test'
import { auditText } from '../../shared/audit-text.ts'
import { SEED_EXPIRED_GRANT_ID } from '../support/test-build/expired-grant.ts'
import { actor, allPages, call, endLiveGrants, expectError } from './kit.ts'
import { auditWhere, readSql } from './db.ts'

const admin = actor('admin')
const alex = actor('inhouse')
const logged = () => readSql<{ ends_at_ms: number; expiry_logged: number }>('SELECT ends_at_ms, expiry_logged FROM support_grants WHERE id = ?', SEED_EXPIRED_GRANT_ID)

test.describe.configure({ mode: 'serial' })

test('before any read, the expired grant is unlogged and gives the Inhouse team no access', async ({ request }) => {
  expect(logged(), 'the prepare step made the grant').toHaveLength(1)
  expect(logged()[0].expiry_logged).toBe(0)
  expect(auditWhere('grant.expired')).toEqual([])
  expectError(await call(request, alex, 'GET', '/api/members'), 403, 'forbidden', 'grant_required')
  expect(logged()[0].expiry_logged, 'a sign-in does not write the expiry').toBe(0)
})

test('the first grants or audit read writes grant.expired once, by the system, dated at the grant\'s end', async ({ request }) => {
  for (let i = 0; i < 2; i++) {
    const list = await call(request, admin, 'GET', '/api/grants')
    expect(list.status, list.text).toBe(200)
    expect(list.json.items.find((g: { id: string }) => g.id === SEED_EXPIRED_GRANT_ID)).toMatchObject({ live: false, endedAt: null, endedBy: null })
    expect((await call(request, admin, 'GET', '/api/audit')).status).toBe(200)
  }
  const expired = auditWhere('grant.expired').filter(l => JSON.parse(l.args_json).grantId === SEED_EXPIRED_GRANT_ID)
  expect(expired, 'written once, not once per read').toHaveLength(1)
  const [grant] = logged()
  expect(grant.expiry_logged).toBe(1)
  expect(expired[0].at_ms, 'the line is dated at the grant\'s end').toBe(grant.ends_at_ms)
  const [system] = readSql<{ kind: string; service_name: string }>('SELECT kind, service_name FROM members WHERE id = ?', expired[0].actor_id)
  expect(system).toEqual({ kind: 'service', service_name: 'system' })

  // The page shows it too, once, in the shared wording.
  const { items } = await allPages<{ what: string; actorId: string }>(request, admin, '/api/audit', 100)
  const wording = auditText({ action: 'grant.expired', grantId: SEED_EXPIRED_GRANT_ID }, () => null).what
  expect(items.filter(i => i.what === wording && i.actorId === expired[0].actor_id)).toHaveLength(1)

  await endLiveGrants(request)
  expectError(await call(request, alex, 'GET', '/api/members'), 403, 'forbidden', 'grant_required')
})
