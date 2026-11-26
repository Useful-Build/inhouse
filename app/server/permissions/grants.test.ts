// Grants, uses and lapses on real D1 (M2-A "Tests"; N10). Ways it can fail, written down first:
//  1. two requests for a grant's last unit both get a use (the day's units pass `MIN(per_day, per_day_max)`);
//  2. a revoke racing a reservation leaves a live use on a dead grant that a later claim accepts, or a revoked grant,
//     a disabled operation or a lowered ceiling still takes a use;
//  3. a second "Always allow" on a live grant makes a second live grant, or a second `permission.granted` line;
//  4. a lapse is computed, not written: a removed then re-invited member, a role drop, a reconnected or disconnected
//     account leave the old grant live (or revoke it without its line, or revoke when the change didn't apply);
//  5. the list shows a member someone else's grant, or a member removes one; a stale `ifRev` removes anything; a
//     removal or a revoke writes a line the schema refuses, or none.
import { fc } from '@fast-check/vitest'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { AuditArgsSchema } from '../../shared/contract/audit.ts'
import { listPermissions, removePermission } from '../api/permissions.ts'
import { openStores } from '../db/stores.ts'
import { at, ctx, lastLineId, linesSince, person as signedInPerson, personPrincipal, reset } from '../db/test-support.ts'
import { setCeilingStmt } from './ceiling.ts'
import { claimGuardSql } from './claim-guard.ts'
import { alwaysAllowStmts, liveGrant, revokeAccountGrantsStmts } from './grants.ts'
import { POLICY_REV } from './policy.ts'
import { releaseUseSql, reserveUseSql, useDay } from './uses.ts'
import { account, ceiling, channel, insertGrant, person, resetPermissions } from './test-support.ts'
import type { GrantFacts } from './types.ts'

const db = env.DB
const stores = openStores(env)
const NOW = 1_800_000_000_000
const SHOP_GEN = 1_000

let k = 0
const uid = () => `${Date.now().toString(36)}${++k}`
const grantId = () => `pg_${uid().padEnd(22, 'A').slice(0, 22)}`
const shopGrant = (holder: string, over: Partial<GrantFacts> = {}): GrantFacts => ({
  id: grantId(), holder, accountId: 'shopify:store', accountGen: SHOP_GEN, operation: 'shopify.order.tag_add', scopeKey: 'shop=store-a',
  perDay: 5, policyRev: POLICY_REV, grantedRole: 'member', ceilingRev: 1, revokedAtMs: null, ...over,
})
const reserve = (grant: string, actionId: string, units = 1, day = '2026-11-26') =>
  reserveUseSql({ actionId, actionRev: 1, grantId: grant, day, units, atMs: NOW })
const run = (s: { sql: string; params: readonly unknown[] }) => db.prepare(s.sql).bind(...s.params).run()
const usesOf = async (grant: string) => (await db.prepare('SELECT * FROM permission_uses WHERE grant_id = ? AND released_at_ms IS NULL').bind(grant).all()).results
const revokedOf = async (id: string) => db.prepare('SELECT revoked_at_ms, revoke_reason FROM permission_grants WHERE id = ?').bind(id).first<{ revoked_at_ms: number | null; revoke_reason: string | null }>()
/** Every line since `mark` that the reader's schema takes: none may be one it refuses. */
const parsedSince = async (mark: number) => (await linesSince(db, mark)).map(l => AuditArgsSchema.parse({ action: l.action, ...JSON.parse(l.args_json) }))

beforeEach(async () => {
  await reset(db)
  await resetPermissions(db)
  await ceiling(db, 'shopify.order.tag_add', { enabled: true, perDayMax: 50, loweredRev: 1 })
  await account(db, 'shopify:store', SHOP_GEN)
})

describe('reserving a use (failures 1 and 2)', () => {
  it('two requests for a grant\'s last unit give one use', async () => {
    await person(db, 'm_use_a', 'member')
    const g = shopGrant('member:m_use_a', { perDay: 3 })
    await insertGrant(db, g)
    await run(reserve(g.id, 'ac_first'))
    await run(reserve(g.id, 'ac_second'))
    const results = await Promise.all([db.batch([db.prepare(reserve(g.id, 'ac_x').sql).bind(...reserve(g.id, 'ac_x').params)]), db.batch([db.prepare(reserve(g.id, 'ac_y').sql).bind(...reserve(g.id, 'ac_y').params)])])
    expect(results.map(r => r[0].meta.changes).sort()).toEqual([0, 1])
    expect(await usesOf(g.id)).toHaveLength(3)
  })

  it('never passes MIN(per_day, per_day_max) for the day, under any order of reservations and releases', async () => {
    await person(db, 'm_use_b', 'member')
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 1, max: 6 }), fc.integer({ min: 1, max: 6 }),
      fc.array(fc.oneof(fc.record({ kind: fc.constant('reserve' as const), units: fc.integer({ min: 1, max: 3 }), day: fc.constantFrom('2026-11-26', '2026-11-27') }), fc.record({ kind: fc.constant('release' as const), pick: fc.nat() })), { maxLength: 12 }),
      async (perDay, perDayMax, steps) => {
        await db.prepare('DELETE FROM permission_uses').run()
        await db.prepare('DELETE FROM permission_grants').run()
        await ceiling(db, 'shopify.order.tag_add', { enabled: true, perDayMax, loweredRev: 1 })
        const g = shopGrant('member:m_use_b', { perDay })
        await insertGrant(db, g)
        const model: { id: string; units: number; day: string; live: boolean }[] = []
        for (const [i, s] of steps.entries()) {
          if (s.kind === 'reserve') {
            const id = `ac_p${i}`
            const used = model.filter(u => u.live && u.day === s.day).reduce((n, u) => n + u.units, 0)
            const fits = used + s.units <= Math.min(perDay, perDayMax)
            const r = await run(reserve(g.id, id, s.units, s.day))
            expect(r.meta.changes).toBe(fits ? 1 : 0)
            if (fits) model.push({ id, units: s.units, day: s.day, live: true })
          } else if (model.length > 0) {
            const u = model[s.pick % model.length]
            await run(releaseUseSql({ actionId: u.id, actionRev: 1, reason: 'undone', atMs: NOW }))
            u.live = false
          }
          for (const day of ['2026-11-26', '2026-11-27']) {
            const sum = (await db.prepare('SELECT COALESCE(SUM(units), 0) AS n FROM permission_uses WHERE grant_id = ? AND day = ? AND released_at_ms IS NULL').bind(g.id, day).first<number>('n'))
            expect(sum).toBeLessThanOrEqual(Math.min(perDay, perDayMax))
          }
        }
      },
    ), { numRuns: 40 })
  })

  it('takes no use on a revoked grant, a disabled operation or a lowered ceiling', async () => {
    await person(db, 'm_use_c', 'member')
    const revoked = shopGrant('member:m_use_c', { revokedAtMs: NOW - 1 })
    await insertGrant(db, revoked)
    expect((await run(reserve(revoked.id, 'ac_r1'))).meta.changes).toBe(0)
    const live = shopGrant('member:m_use_c')
    await insertGrant(db, live)
    await ceiling(db, 'shopify.order.tag_add', { enabled: true, perDayMax: 50, loweredRev: 2 })
    expect((await run(reserve(live.id, 'ac_r2'))).meta.changes).toBe(0)
    await ceiling(db, 'shopify.order.tag_add', { enabled: false, perDayMax: 50, loweredRev: 1 })
    expect((await run(reserve(live.id, 'ac_r3'))).meta.changes).toBe(0)
    await ceiling(db, 'shopify.order.tag_add', { enabled: true, perDayMax: 50, loweredRev: 1 })
    expect((await run(reserve(live.id, 'ac_r4'))).meta.changes).toBe(1)
  })

  it('a revoke racing a reservation: whichever lands first, no later use and no claim go through on the dead grant', async () => {
    await person(db, 'm_use_d', 'member')
    for (const order of ['parallel', 'revoke_first'] as const) {
      const g = shopGrant('member:m_use_d', { scopeKey: `shop=${order}` })
      await insertGrant(db, g)
      const revoke = db.prepare("UPDATE permission_grants SET revoked_at_ms = ?, revoke_reason = 'removed', rev = rev + 1 WHERE id = ? AND revoked_at_ms IS NULL").bind(NOW, g.id)
      const take = db.prepare(reserve(g.id, `ac_${order}`).sql).bind(...reserve(g.id, `ac_${order}`).params)
      if (order === 'parallel') await Promise.all([db.batch([revoke]), db.batch([take])])
      else { await db.batch([revoke]); await db.batch([take]) }
      if (order === 'revoke_first') expect(await usesOf(g.id)).toHaveLength(0)
      expect((await run(reserve(g.id, `ac_${order}_later`))).meta.changes).toBe(0)
      // The claim re-checks the grant: an action holding a use from before the revoke is still refused.
      const guard = claimGuardSql('a')
      const passes = await db.prepare(`WITH a AS (SELECT ? AS id, 1 AS rev, 'run' AS verdict, 'chat' AS origin, 'm_use_d' AS asked_by, NULL AS approved_by,
          ? AS grant_id, 'shopify:store' AS account_id, ? AS account_gen, 'shopify.order.tag_add' AS operation, ? AS policy_rev, ? AS scope_key,
          '{"shop":"store-a"}' AS scope_json, 1 AS records) SELECT COUNT(*) AS n FROM a WHERE ${guard.sql}`)
        .bind(`ac_${order}`, g.id, SHOP_GEN, POLICY_REV, g.scopeKey, ...guard.params).first<number>('n')
      expect(passes).toBe(0)
    }
  })

  it('names the brand\'s own day in its time zone', () => {
    // 2026-11-26 03:00 UTC is still the 25th in New York.
    expect(useDay(Date.parse('2026-11-26T03:00:00Z'), 'America/New_York')).toBe('2026-11-25')
    expect(useDay(Date.parse('2026-11-26T03:00:00Z'), 'Europe/London')).toBe('2026-11-26')
    expect(() => useDay(NOW, 'Not/AZone')).toThrow()
  })
})

describe('"Always allow" (failure 3)', () => {
  const resolved = { accountId: 'shopify:store', accountGen: SHOP_GEN, operation: 'shopify.order.tag_add' as const, scope: { shop: 'store-a' }, scopeKey: 'shop=store-a', policyRev: POLICY_REV }
  const always = (memberId: string, action: string, onlyIf = { sql: 'SELECT 1', params: [] }) =>
    alwaysAllowStmts({ holderMemberId: memberId, grantedRole: 'member', resolved, perDay: 50, sourceAction: action, onlyIf, at: at(memberId, NOW) })

  it('a second Always allow on a live grant makes no second grant and no second line; both read the one grant back', async () => {
    await person(db, 'm_always_a', 'member')
    const mark = await lastLineId(db)
    const a = always('m_always_a', 'ac_AAAAAAAAAAAAAAAAAAAAAA')
    const b = always('m_always_a', 'ac_BBBBBBBBBBBBBBBBBBBBBB')
    await Promise.all([db.batch(a.stmts.map(s => db.prepare(s.sql).bind(...s.params))), db.batch(b.stmts.map(s => db.prepare(s.sql).bind(...s.params)))])
    const live = await liveGrant(db, { holder: 'member:m_always_a', accountId: 'shopify:store', operation: 'shopify.order.tag_add', scopeKey: 'shop=store-a' })
    expect([a.id, b.id]).toContain(live?.id)
    expect(live).toMatchObject({ ceiling_rev: 1, policy_rev: POLICY_REV, granted_role: 'member', per_day: 50 })
    const lines = await parsedSince(mark)
    expect(lines).toEqual([{ action: 'permission.granted', permissionId: live!.id, operation: 'shopify.order.tag_add', accountId: 'shopify:store', scopeKey: 'shop=store-a', holder: 'member', perDay: 50, actionId: live!.source_action }])
  })

  it('adds nothing for an answer resolved before a reconnect or a policy change, or a holder removed or below the granted role', async () => {
    await person(db, 'm_always_c', 'member')
    const mark = await lastLineId(db)
    const tryAlways = async (over: Partial<typeof resolved>, grantedRole: 'member' | 'admin' = 'member') => {
      const a = alwaysAllowStmts({ holderMemberId: 'm_always_c', grantedRole, resolved: { ...resolved, ...over }, perDay: 50, sourceAction: 'ac_IIIIIIIIIIIIIIIIIIIIII', onlyIf: { sql: 'SELECT 1', params: [] }, at: at('m_always_c', NOW) })
      await db.batch(a.stmts.map(s => db.prepare(s.sql).bind(...s.params)))
    }
    await account(db, 'shopify:store', SHOP_GEN + 1)
    await tryAlways({})
    await tryAlways({ accountGen: SHOP_GEN + 1, policyRev: POLICY_REV + 1 })
    await tryAlways({ accountGen: SHOP_GEN + 1 }, 'admin')
    await person(db, 'm_always_c', 'member', 'removed')
    await tryAlways({ accountGen: SHOP_GEN + 1 })
    expect(await db.prepare('SELECT COUNT(*) AS n FROM permission_grants').first('n')).toBe(0)
    expect(await linesSince(db, mark)).toEqual([])
    await person(db, 'm_always_c', 'member')
    await tryAlways({ accountGen: SHOP_GEN + 1 })
    expect(await db.prepare('SELECT COUNT(*) AS n FROM permission_grants').first('n')).toBe(1)
  })

  it('adds nothing when the operation is off or the answer lost (onlyIf), and takes the ceiling\'s current revision', async () => {
    await person(db, 'm_always_b', 'member')
    const mark = await lastLineId(db)
    const lost = always('m_always_b', 'ac_CCCCCCCCCCCCCCCCCCCCCC', { sql: 'SELECT 1 WHERE 0', params: [] })
    await db.batch(lost.stmts.map(s => db.prepare(s.sql).bind(...s.params)))
    await ceiling(db, 'shopify.order.tag_add', { enabled: false, perDayMax: 50, loweredRev: 3 })
    const off = always('m_always_b', 'ac_DDDDDDDDDDDDDDDDDDDDDD')
    await db.batch(off.stmts.map(s => db.prepare(s.sql).bind(...s.params)))
    expect(await db.prepare('SELECT COUNT(*) AS n FROM permission_grants').first('n')).toBe(0)
    expect(await linesSince(db, mark)).toEqual([])
    await ceiling(db, 'shopify.order.tag_add', { enabled: true, perDayMax: 50, loweredRev: 3 })
    const on = always('m_always_b', 'ac_EEEEEEEEEEEEEEEEEEEEEE')
    await db.batch(on.stmts.map(s => db.prepare(s.sql).bind(...s.params)))
    expect(await db.prepare('SELECT ceiling_rev FROM permission_grants WHERE id = ?').bind(on.id).first('ceiling_rev')).toBe(3)
  })
})

describe('a dead grant never blocks a new "Always allow" (review round 1)', () => {
  const resolved = { accountId: 'shopify:store', accountGen: SHOP_GEN, operation: 'shopify.order.tag_add' as const, scope: { shop: 'store-a' }, scopeKey: 'shop=store-a', policyRev: POLICY_REV }
  const always = async (memberId: string, action: string) => {
    const a = alwaysAllowStmts({ holderMemberId: memberId, grantedRole: 'member', resolved, perDay: 50, sourceAction: action, onlyIf: { sql: 'SELECT 1', params: [] }, at: at(memberId, NOW) })
    await db.batch(a.stmts.map(x => db.prepare(x.sql).bind(...x.params)))
    return a.id
  }
  const key = (memberId: string) => ({ holder: `member:${memberId}`, accountId: 'shopify:store', operation: 'shopify.order.tag_add' as const, scopeKey: 'shop=store-a' })

  for (const [what, stale] of [
    ['a lowered ceiling', async (g: GrantFacts) => { await insertGrant(db, g); await run(setCeilingStmt({ operation: 'shopify.order.tag_add', enabled: true, perDayMax: 10, actorId: 'm_system', nowMs: NOW })) }],
    ['a policy bump', async (g: GrantFacts) => insertGrant(db, { ...g, policyRev: POLICY_REV - 1 })],
    ['a reconnect left unrevoked', async (g: GrantFacts) => insertGrant(db, { ...g, accountGen: SHOP_GEN - 1 })],
  ] as const) {
    it(`after ${what}, Always allow again makes a fresh live grant and ends the dead one as superseded`, async () => {
      await db.prepare('DELETE FROM permission_ceiling').run()
      await run(setCeilingStmt({ operation: 'shopify.order.tag_add', enabled: true, perDayMax: 50, actorId: 'm_system', nowMs: NOW }))
      await person(db, 'm_dead_a', 'member')
      const old = shopGrant('member:m_dead_a', { perDay: 50 })
      await stale(old)
      // Dead: no reservation, not listed, not read back as live.
      expect((await run(reserve(old.id, `ac_dead_${what.length}`))).meta.changes).toBe(0)
      expect(await liveGrant(db, key('m_dead_a'))).toBeNull()
      expect(await stores.permissions.list({ memberId: 'm_dead_a', role: 'member' })).toEqual([])
      const mark = await lastLineId(db)
      const id = await always('m_dead_a', 'ac_FFFFFFFFFFFFFFFFFFFFFF')
      expect((await liveGrant(db, key('m_dead_a')))?.id).toBe(id)
      expect(await revokedOf(old.id)).toEqual({ revoked_at_ms: NOW, revoke_reason: 'superseded' })
      expect((await parsedSince(mark)).map(l => [l.action, 'reason' in l ? l.reason : null])).toEqual([['permission.revoked', 'superseded'], ['permission.granted', null]])
      expect((await run(reserve(id, `ac_fresh_${what.length}`))).meta.changes).toBe(1)
      expect((await stores.permissions.list({ memberId: 'm_dead_a', role: 'member' })).map(p => p.id)).toEqual([id])
    })
  }

  it('ends nothing as superseded when no new grant is made (an ineligible answer) (review round 2)', async () => {
    await db.prepare('DELETE FROM permission_ceiling').run()
    await run(setCeilingStmt({ operation: 'shopify.order.tag_add', enabled: true, perDayMax: 50, actorId: 'm_system', nowMs: NOW }))
    await person(db, 'm_dead_c', 'member')
    const old = shopGrant('member:m_dead_c', { policyRev: POLICY_REV - 1 })
    await insertGrant(db, old)
    const mark = await lastLineId(db)
    // Resolved before a reconnect: not eligible, so the dead grant stays as it is and no line says it was replaced.
    await account(db, 'shopify:store', SHOP_GEN + 1)
    await always('m_dead_c', 'ac_JJJJJJJJJJJJJJJJJJJJJJ')
    await person(db, 'm_dead_c', 'member', 'removed')
    await account(db, 'shopify:store', SHOP_GEN)
    await always('m_dead_c', 'ac_KKKKKKKKKKKKKKKKKKKKKK')
    expect((await revokedOf(old.id))?.revoked_at_ms).toBeNull()
    expect(await linesSince(db, mark)).toEqual([])
  })

  it('leaves a current grant alone: a second Always allow reads the same one back', async () => {
    await person(db, 'm_dead_b', 'member')
    const first = await always('m_dead_b', 'ac_GGGGGGGGGGGGGGGGGGGGGG')
    await always('m_dead_b', 'ac_HHHHHHHHHHHHHHHHHHHHHH')
    expect((await liveGrant(db, key('m_dead_b')))?.id).toBe(first)
    expect((await revokedOf(first))?.revoked_at_ms).toBeNull()
  })
})

describe('Slack and disconnects (review round 2)', () => {
  const post = { accountId: 'slack:workspace', accountGen: 2_000, operation: 'slack.channel.post' as const, scope: { channelId: 'C0ROUND201' }, scopeKey: 'channelId=C0ROUND201', policyRev: POLICY_REV }
  beforeEach(async () => {
    await account(db, 'slack:workspace', 2_000)
    await ceiling(db, 'slack.channel.post', { enabled: true, perDayMax: 50, loweredRev: 1 })
    await person(db, 'm_r2_a', 'member')
    await person(db, 'm_r2_admin', 'admin')
    await channel(db, 'C0ROUND201', 'ops', 'm_r2_admin')
  })
  const alwaysPost = async (action: string) => {
    const a = alwaysAllowStmts({ holderMemberId: 'm_r2_a', grantedRole: 'member', resolved: post, perDay: 50, sourceAction: action, onlyIf: { sql: 'SELECT 1', params: [] }, at: at('m_r2_a', NOW) })
    await db.batch(a.stmts.map(x => db.prepare(x.sql).bind(...x.params)))
  }
  const count = () => db.prepare("SELECT COUNT(*) AS n FROM permission_grants WHERE holder = 'member:m_r2_a'").first<number>('n')

  it('makes no grant for a channel taken off the list while its card waited; relisting brings none', async () => {
    await db.prepare("UPDATE notify_channels SET removed_at_ms = 5, removed_by = 'm_r2_admin' WHERE channel_id = 'C0ROUND201'").run()
    await alwaysPost('ac_LLLLLLLLLLLLLLLLLLLLLL')
    await db.prepare('UPDATE notify_channels SET removed_at_ms = NULL, removed_by = NULL WHERE channel_id = ?').bind('C0ROUND201').run()
    expect(await count()).toBe(0)
    await alwaysPost('ac_MMMMMMMMMMMMMMMMMMMMMM')
    expect(await count()).toBe(1)
  })

  it('a disconnected account\'s grant is neither listed, read back as live nor reserved', async () => {
    await alwaysPost('ac_NNNNNNNNNNNNNNNNNNNNNN')
    const live = await liveGrant(db, { holder: 'member:m_r2_a', accountId: 'slack:workspace', operation: 'slack.channel.post', scopeKey: 'channelId=C0ROUND201' })
    expect(live).not.toBeNull()
    await db.prepare('UPDATE connector_accounts SET disconnected_at_ms = ? WHERE account_id = ?').bind(2_500, 'slack:workspace').run()
    expect(await liveGrant(db, { holder: 'member:m_r2_a', accountId: 'slack:workspace', operation: 'slack.channel.post', scopeKey: 'channelId=C0ROUND201' })).toBeNull()
    expect(await stores.permissions.list({ memberId: 'm_r2_a', role: 'member' })).toEqual([])
    expect((await run(reserve(live!.id, 'ac_r2_use'))).meta.changes).toBe(0)
  })
})

describe('lapses are written (failure 4)', () => {
  let n = 0
  const email = () => `perm-${uid()}-${++n}@example.com`

  it('a removed then re-invited member keeps the id and not the grant', async () => {
    const admin = await signedInPerson(stores, { email: email(), subject: `s-${uid()}`, role: 'admin' })
    const mem = await signedInPerson(stores, { email: email(), subject: `s-${uid()}`, role: 'member' })
    const g = shopGrant(`member:${mem}`)
    await insertGrant(db, g)
    const mark = await lastLineId(db)
    const rec = await stores.members.get(mem)
    const removed = await stores.members.remove({ id: mem, ifRev: rec!.rev }, at(admin, NOW))
    expect('ok' in removed).toBe(true)
    expect(await revokedOf(g.id)).toEqual({ revoked_at_ms: NOW, revoke_reason: 'member_removed' })
    expect((await parsedSince(mark)).map(l => l.action)).toEqual(['member.removed', 'permission.revoked'])
    const again = await stores.members.invite({ name: 'Pat Again', email: (await db.prepare('SELECT email_norm FROM members WHERE id = ?').bind(mem).first<string>('email_norm'))!, role: 'member' }, at(admin, NOW + 1))
    expect('ok' in again && again.ok.id).toBe(mem)
    expect((await revokedOf(g.id))?.revoke_reason).toBe('member_removed')
    expect(await liveGrant(db, { holder: `member:${mem}`, accountId: g.accountId, operation: g.operation, scopeKey: g.scopeKey })).toBeNull()
  })

  it('a role drop ends the member\'s grants; a stale role change ends none', async () => {
    const admin = await signedInPerson(stores, { email: email(), subject: `s-${uid()}`, role: 'admin' })
    const other = await signedInPerson(stores, { email: email(), subject: `s-${uid()}`, role: 'admin' })
    const g = shopGrant(`member:${other}`, { grantedRole: 'admin' })
    await insertGrant(db, g)
    const rec = await stores.members.get(other)
    const stale = await stores.members.changeRole({ id: other, role: 'member', ifRev: rec!.rev + 7 }, at(admin, NOW))
    expect('conflict' in stale).toBe(true)
    expect((await revokedOf(g.id))?.revoked_at_ms).toBeNull()
    const mark = await lastLineId(db)
    const done = await stores.members.changeRole({ id: other, role: 'member', ifRev: rec!.rev }, at(admin, NOW))
    expect('ok' in done).toBe(true)
    expect(await revokedOf(g.id)).toEqual({ revoked_at_ms: NOW, revoke_reason: 'role_lowered' })
    expect((await parsedSince(mark)).map(l => l.action)).toEqual(['member.role_changed', 'permission.revoked'])
  })

  it('a reconnected account ends the grants on the old generation; a disconnect ends them all', async () => {
    await person(db, 'm_lapse_c', 'member')
    await person(db, 'm_lapse_admin', 'admin')
    const old = shopGrant('member:m_lapse_c')
    await insertGrant(db, old)
    const mark = await lastLineId(db)
    const newGen = NOW + 5
    await stores.connectors.connectEnded('shopify:store', 'shopify', 'ok', 'connected', at('m_lapse_admin', newGen))
    expect(await revokedOf(old.id)).toEqual({ revoked_at_ms: newGen, revoke_reason: 'account_reconnected' })
    const fresh = shopGrant('member:m_lapse_c', { accountGen: newGen })
    await insertGrant(db, fresh)
    const failed = await stores.connectors.connectEnded('shopify:store', 'shopify', 'connect_refused', 'connected', at('m_lapse_admin', newGen + 1))
    expect(failed).toBeUndefined()
    expect((await revokedOf(fresh.id))?.revoked_at_ms).toBeNull()
    await stores.connectors.recordDisconnect('shopify:store', 'shopify', { action: 'tools.disconnect', accountId: 'shopify:store', revoked: true }, at('m_lapse_admin', newGen + 2))
    expect(await revokedOf(fresh.id)).toEqual({ revoked_at_ms: newGen + 2, revoke_reason: 'account_disconnected' })
    const actions = (await parsedSince(mark)).map(l => l.action)
    expect(actions).toEqual(['tools.connect', 'permission.revoked', 'tools.connect', 'tools.disconnect', 'permission.revoked'])
  })

  it('a channel taken off the list ends its grants; listing it again brings none back', async () => {
    await person(db, 'm_lapse_e', 'member')
    await person(db, 'm_lapse_admin', 'admin')
    await account(db, 'slack:workspace', 2_000)
    const listed = await stores.notify.save({ channels: [{ channelId: 'C0LAPSE001', name: 'ops' }, { channelId: 'C0LAPSE002', name: 'stock' }], alertsChannelId: null, ifRev: (await stores.notify.list()).rev }, at('m_lapse_admin', NOW))
    expect('ok' in listed).toBe(true)
    const post = (channelId: string): GrantFacts => ({ ...shopGrant('member:m_lapse_e'), operation: 'slack.channel.post', accountId: 'slack:workspace', accountGen: 2_000, scopeKey: `channelId=${channelId}` })
    const gone = post('C0LAPSE001')
    const kept = post('C0LAPSE002')
    await insertGrant(db, gone)
    await insertGrant(db, kept)
    const mark = await lastLineId(db)
    const rev = (await stores.notify.list()).rev
    const stale = await stores.notify.save({ channels: [{ channelId: 'C0LAPSE002', name: 'stock' }], alertsChannelId: null, ifRev: rev + 3 }, at('m_lapse_admin', NOW))
    expect('conflict' in stale).toBe(true)
    expect((await revokedOf(gone.id))?.revoked_at_ms).toBeNull()
    await stores.notify.save({ channels: [{ channelId: 'C0LAPSE002', name: 'stock' }], alertsChannelId: null, ifRev: rev }, at('m_lapse_admin', NOW))
    expect(await revokedOf(gone.id)).toEqual({ revoked_at_ms: NOW, revoke_reason: 'channel_unlisted' })
    expect((await revokedOf(kept.id))?.revoked_at_ms).toBeNull()
    expect((await parsedSince(mark)).map(l => l.action)).toEqual(['permission.revoked', 'notify.channels'])
    await stores.notify.save({ channels: [{ channelId: 'C0LAPSE001', name: 'ops' }, { channelId: 'C0LAPSE002', name: 'stock' }], alertsChannelId: null, ifRev: rev + 1 }, at('m_lapse_admin', NOW + 1))
    expect((await revokedOf(gone.id))?.revoke_reason).toBe('channel_unlisted')
  })

  it('revokes only where the triggering change applied', async () => {
    await person(db, 'm_lapse_d', 'member')
    const g = shopGrant('member:m_lapse_d')
    await insertGrant(db, g)
    const stmts = revokeAccountGrantsStmts('shopify:store', null, at('m_lapse_d', NOW), { sql: 'SELECT 1 WHERE 0', params: [] })
    await db.batch(stmts.map(s => db.prepare(s.sql).bind(...s.params)))
    expect((await revokedOf(g.id))?.revoked_at_ms).toBeNull()
  })
})

describe('the list and remove (failure 5)', () => {
  beforeEach(async () => {
    await account(db, 'slack:workspace', 2_000)
    await ceiling(db, 'slack.channel.post', { enabled: true, perDayMax: 50, loweredRev: 1 })
    await person(db, 'm_list_a', 'member')
    await person(db, 'm_list_b', 'member')
    await person(db, 'm_list_admin', 'admin')
    await channel(db, 'C0LIST0001', 'ops', 'm_list_admin')
  })
  const mine = shopGrant('member:m_list_a')
  const theirs: GrantFacts = { ...shopGrant('member:m_list_b'), operation: 'slack.channel.post', accountId: 'slack:workspace', accountGen: 2_000, scopeKey: 'channelId=C0LIST0001' }

  it('a member sees and removes only their own; an admin sees and removes any; the answers are server words', async () => {
    await insertGrant(db, { ...mine, id: grantId() }, NOW - 10)
    const a = { ...mine, id: grantId(), scopeKey: 'shop=store-b' }
    await insertGrant(db, a, NOW - 5)
    const b = { ...theirs, id: grantId() }
    await insertGrant(db, b, NOW)
    const forA = await stores.permissions.list({ memberId: 'm_list_a', role: 'member' })
    expect(forA.map(p => p.holder)).toEqual([{ kind: 'member', memberId: 'm_list_a' }, { kind: 'member', memberId: 'm_list_a' }])
    expect(forA[0]).toMatchObject({ id: a.id, title: 'Add tags to orders', tool: { accountId: 'shopify:store', label: 'Shopify' }, scope: 'store-b', can: { remove: true } })
    const forAdmin = await stores.permissions.list({ memberId: 'm_list_admin', role: 'admin' })
    expect(forAdmin.map(p => p.id)[0]).toBe(b.id)
    expect(forAdmin[0]).toMatchObject({ title: 'Post messages to a channel', tool: { label: 'Slack' }, scope: '#ops', can: { remove: true } })

    expect(await stores.permissions.remove({ id: b.id, ifRev: 1 }, { memberId: 'm_list_a', role: 'member' }, at('m_list_a', NOW))).toEqual({ refused: 'not_found' })
    expect((await revokedOf(b.id))?.revoked_at_ms).toBeNull()
    const stale = await stores.permissions.remove({ id: a.id, ifRev: 2 }, { memberId: 'm_list_a', role: 'member' }, at('m_list_a', NOW))
    expect('conflict' in stale && stale.conflict.id).toBe(a.id)
    const mark = await lastLineId(db)
    const ok = await stores.permissions.remove({ id: b.id, ifRev: 1 }, { memberId: 'm_list_admin', role: 'admin' }, at('m_list_admin', NOW))
    expect('ok' in ok && ok.ok.map(p => p.id)).not.toContain(b.id)
    expect(await revokedOf(b.id)).toEqual({ revoked_at_ms: NOW, revoke_reason: 'removed' })
    expect(await parsedSince(mark)).toEqual([{ action: 'permission.revoked', permissionId: b.id, operation: 'slack.channel.post', reason: 'removed' }])
    expect(await stores.permissions.remove({ id: b.id, ifRev: 2 }, { memberId: 'm_list_admin', role: 'admin' }, at('m_list_admin', NOW))).toEqual({ refused: 'not_found' })
  })

  it('refuses an admin\'s removal once their role was lowered, in the statement', async () => {
    const b = { ...theirs, id: grantId() }
    await insertGrant(db, b)
    await person(db, 'm_list_admin', 'member')
    const stale = { memberId: 'm_list_admin', role: 'admin' } as const
    // Not a 409 carrying another member's grant: the stale principal sees only its own (review round 1).
    expect(await stores.permissions.remove({ id: b.id, ifRev: 1 }, stale, at('m_list_admin', NOW))).toEqual({ refused: 'not_found' })
    expect(await stores.permissions.remove({ id: b.id, ifRev: 7 }, stale, at('m_list_admin', NOW))).toEqual({ refused: 'not_found' })
    expect(await stores.permissions.list(stale)).toEqual([])
    expect((await revokedOf(b.id))?.revoked_at_ms).toBeNull()
  })

  it('names a channel no longer listed without a #', async () => {
    const b = { ...theirs, id: grantId() }
    await insertGrant(db, b)
    await db.prepare("UPDATE notify_channels SET removed_at_ms = 5, removed_by = 'm_list_admin' WHERE channel_id = 'C0LIST0001'").run()
    expect((await stores.permissions.list({ memberId: 'm_list_b', role: 'member' }))[0]?.scope).toBe('a channel no longer listed')
  })

  it('routes 110 and 111 answer the list, 404 for an id the caller can\'t see, 409 with the current grant when stale', async () => {
    const b = { ...theirs, id: grantId() }
    await insertGrant(db, b)
    const list = await listPermissions(ctx(stores, personPrincipal('m_list_b', 'member'), { path: '/api/permissions' }).c)
    expect(list.status).toBe(200)
    expect(((await list.json()) as { items: { id: string }[] }).items.map(i => i.id)).toEqual([b.id])
    const notMine = await removePermission(ctx(stores, personPrincipal('m_list_a', 'member'), { method: 'POST', path: `/api/permissions/${b.id}/remove`, params: { id: b.id }, body: { ifRev: 1 } }).c)
    expect(notMine.status).toBe(404)
    const stale = await removePermission(ctx(stores, personPrincipal('m_list_b', 'member'), { method: 'POST', path: `/api/permissions/${b.id}/remove`, params: { id: b.id }, body: { ifRev: 9 } }).c)
    expect(stale.status).toBe(409)
    expect(((await stale.json()) as { error: { current: { id: string; rev: number } } }).error.current).toMatchObject({ id: b.id, rev: 1 })
    const bad = await removePermission(ctx(stores, personPrincipal('m_list_b', 'member'), { method: 'POST', path: '/api/permissions/nope/remove', params: { id: 'nope' }, body: { ifRev: 1 } }).c)
    expect(bad.status).toBe(404)
    const done = await removePermission(ctx(stores, personPrincipal('m_list_b', 'member'), { method: 'POST', path: `/api/permissions/${b.id}/remove`, params: { id: b.id }, body: { ifRev: 1 } }).c)
    expect(done.status).toBe(200)
    expect(await done.json()).toEqual({ items: [] })
  })
})

describe('the ceiling (a lowered ceiling leaves the old grant dead)', () => {
  const set = (enabled: boolean, perDayMax: number) => run(setCeilingStmt({ operation: 'shopify.order.tag_add', enabled, perDayMax, actorId: 'm_system', nowMs: NOW }))
  const rev = () => db.prepare("SELECT lowered_rev FROM permission_ceiling WHERE operation = 'shopify.order.tag_add'").first<number>('lowered_rev')

  it('raises lowered_rev when turned off or given a smaller maximum, never when raised; the old grant stays dead', async () => {
    await db.prepare('DELETE FROM permission_ceiling').run()
    await person(db, 'm_ceil', 'member')
    await set(true, 10)
    expect(await rev()).toBe(1)
    const g = shopGrant('member:m_ceil')
    await insertGrant(db, g)
    expect((await run(reserve(g.id, 'ac_c1'))).meta.changes).toBe(1)
    await set(true, 20)
    expect(await rev()).toBe(1)
    await set(true, 5)
    expect(await rev()).toBe(2)
    expect((await run(reserve(g.id, 'ac_c2'))).meta.changes).toBe(0)
    await set(false, 5)
    await set(true, 50)
    expect(await rev()).toBe(3)
    expect((await run(reserve(g.id, 'ac_c3'))).meta.changes).toBe(0)
  })
})
