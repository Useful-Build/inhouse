// A backup holding batches (Stage 1 M3-B, N22; #500's review, #502), restored into a fresh database: one per file, as
// round-trip.test.ts (the audit log can't be emptied). The source holds an answered batch whose remainder moved to a
// new card, a batch stopped part way (some items sent, the rest moved), a finished batch, a waiting collecting batch
// and a grant-backed run batch. Ways it can fail, written down first:
//  1. the restore refuses or fails on an item of an answered batch (an item at a position its approval covers);
//  2. a row or a value of `outbox_actions` or `outbox_items` differs between source and target, or the proof isn't
//     verified for them;
//  3. the restored items lose what 0770's triggers guard: an item's identity still can't change on the target.
import { applyD1Migrations } from 'cloudflare:test'
import type { D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { SYSTEM_MEMBER_ID } from '../../server/db/ids.ts'
import { POLICY_REV } from '../../server/permissions/policy.ts'
import { ceiling, insertGrant } from '../../server/permissions/test-support.ts'
import { ASKER, SHOP_GEN, fresh, outbox, requestCtx, tagArgs, world } from '../../server/outbox/test-support.ts'
import { itemHub, pass, wideArgs } from '../../server/outbox/batch/test-support.ts'
import type { OutboxActionRow } from '../../server/outbox/types.ts'
import { backup } from './backup.ts'
import { restore } from './restore.ts'

const e = env as Env & { RESTORE_DB: D1Database; TEST_MIGRATIONS: D1Migration[] }
const T0 = 1_800_000_000_000
const ME = { memberId: ASKER, role: 'member' as const }

it('restores answered, moved, stopped, finished and waiting batches exactly, their items with them', async () => {
  await applyD1Migrations(e.RESTORE_DB, e.TEST_MIGRATIONS)
  const db = e.DB
  await world(db)
  await ceiling(db, 'shopify.order.tag_add', { enabled: true, perDayMax: 50, loweredRev: 1, unitsMax: 100 })
  let now = T0
  const clock = () => now
  const ask = (args: unknown, chatId = 'c_rt_one') => outbox(db, clock).request(requestCtx({ nowMs: now, chatId }), { operation: 'shopify.order.tag_add', args }, { mode: 'tool' })
  const approve = async (b: OutboxActionRow, upTo: number) => {
    const t = await db.prepare('SELECT SUM(records) AS records, SUM(units) AS units FROM outbox_items WHERE action_id = ? AND n <= ?').bind(b.id, upTo).first<{ records: number; units: number }>()
    const r = await outbox(db, clock).answer(ME, b.id, { choice: 'approve', ifRev: b.rev, upTo, totals: t! })
    if (!('action' in r)) throw new Error(`answer refused: ${r.refused.code}`)
    return r.action
  }
  const collected = async (chatId: string, from: number, n: number) => {
    for (let k = 1; k <= 5; k++) await ask(tagArgs(k), chatId)
    let last = null
    for (let k = 0; k < n; k++) last = await ask(tagArgs(from + k), chatId)
    if (!last || last.outcome !== 'collected') throw new Error('expected a collected call')
    return last.action
  }

  // An answered batch of 6 approved up to 4 (its remainder of 2 on a new collecting card), then sent in part: a
  // Pause at the 3rd item's call stops it (its last item moves to a new card).
  const answered = await approve(await collected('c_rt_one', 100, 6), 4)
  now += 10_000
  const gate = { paused: false, pauseGen: 0 }
  let calls = 0
  await pass(db, answered.id, { nowMs: now, gate, hub: itemHub(db, () => { if (++calls === 3) { gate.paused = true; gate.pauseGen = 1 } return 'ok' }).gateway })
  await db.prepare('UPDATE outbox_gate SET do_gen = 1, paused = 1, epoch = epoch + 1').run()
  await db.prepare('UPDATE outbox_gate SET do_gen = 2, paused = 0, epoch = epoch + 1').run()
  // A finished batch in another chat, and one waiting there to be answered.
  const finished = await approve(await collected('c_rt_two', 200, 3), 3)
  now += 10_000
  await pass(db, finished.id, { nowMs: now, gate: { paused: false, pauseGen: 2 }, hub: itemHub(db, () => 'ok').gateway })
  await ask(tagArgs(300), 'c_rt_two')
  // A grant-backed run batch of 3 orders, approved and not yet sent.
  await insertGrant(db, {
    id: `pg_${fresh('g').replace(/[^A-Za-z0-9]/g, '').padEnd(22, 'A').slice(0, 22)}`, holder: `member:${ASKER}`, accountId: 'shopify:store',
    accountGen: SHOP_GEN, operation: 'shopify.order.tag_add', scopeKey: 'shop=store-a', perDay: 50, unitsMax: 5, policyRev: POLICY_REV,
    grantedRole: 'member', ceilingRev: 1, revokedAtMs: null,
  })
  expect((await ask(wideArgs([7, 8, 9]), 'c_rt_three')).outcome).toBe('approved')

  const states = (await db.prepare("SELECT state, COUNT(*) AS n FROM outbox_actions WHERE kind = 'batch' GROUP BY state ORDER BY state").all()).results
  expect(states).toEqual([{ state: 'approved', n: 1 }, { state: 'sent', n: 2 }, { state: 'waiting', n: 3 }])
  const itemStates = (await db.prepare('SELECT state, COUNT(*) AS n FROM outbox_items GROUP BY state ORDER BY state').all()).results
  expect(itemStates).toEqual([{ state: 'pending', n: 7 }, { state: 'sent', n: 6 }])

  now += 1_000
  const manifest = await backup({ db, bucket: e.FILES, nowMs: now })
  const record = await restore({
    bucket: e.FILES, target: e.RESTORE_DB, live: db, backupId: manifest.backupId, at: { actorId: SYSTEM_MEMBER_ID, requestId: 'req-rt-batches', nowMs: now + 1 },
    resetAfterRestore: [],
  })
  // Failure 1.
  expect(record.status, record.reason).toBe('restored_unreconciled')
  // Failure 2.
  for (const name of ['outbox_actions', 'outbox_items']) {
    expect(record.d1.tables.find(t => t.name === name), name).toMatchObject({ verified: true })
    const dump = async (d: D1Database) => (await d.prepare(`SELECT * FROM ${name} ORDER BY ${name === 'outbox_items' ? 'item_id' : 'id'}`).all()).results
    const source = await dump(db)
    expect(source.length).toBeGreaterThan(0)
    expect(await dump(e.RESTORE_DB)).toEqual(source)
  }
  // Failure 3: the triggers hold on the target.
  await expect(e.RESTORE_DB.prepare("UPDATE outbox_items SET args_json = '{}'").run()).rejects.toThrow(/fixed/)
})
