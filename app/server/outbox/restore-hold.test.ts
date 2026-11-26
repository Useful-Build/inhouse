// The restore hold on real D1 (M2-R, N12): the batch the reconcile's step 4 runs, and the confirm's release. The real
// restore of a backup, end to end, is ops/backup/reconcile/hold.test.ts. Invariants, written before the code:
//  H1. after the hold, no row is `approved` or `sending`, the gate is held at `do_gen = -1` and its epoch moved on;
//  H2. a `waiting` row with a deny, withdraw or expiry line above the backup's audit id is closed that way (deny first),
//      with its line's time as its final time; otherwise a row goes to `needs_check` exactly when it was `approved` or
//      `sending`, or `waiting` with an approving answer line above that id (any `waiting` row when lines were lost);
//      every other row is untouched;
//  H3. each held row has exactly one `action.needs_check` line (`why: 'restore'`, its attempt when it had one) under
//      the restore's request id, and every line the hold writes parses against the audit schema;
//  H4. no grant is live after it; each grant that was live has exactly one `permission.revoked` line (`restore`); a
//      grant revoked before keeps its own revoke;
//  H5. uses (a held row's included) are untouched; a second run changes no row, grant or line;
//  H7. once this restore's `restore.confirmed` line exists, the hold changes nothing (a reconcile racing the confirm);
//  H8. the re-append's exemption (`HOLD_LINES`) matches the hold's two line kinds under its request id, nothing else;
//  H6. while held, a sync (a Resume, a sweep) re-seats `do_gen` but never clears the hold, an answer is refused and no
//      claim wins; only the release (under a `restore.confirmed` line) clears it and sets `do_gen` back to -1, so the
//      first claim after it is refused until a sync re-seats the gate, and then an approval is claimed.
import { fc } from '@fast-check/vitest'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { AuditArgsSchema } from '../../shared/contract/audit.ts'
import { auditInsert } from '../db/audit.ts'
import { runBatch } from '../db/sql.ts'
import { newPermissionId } from '../permissions/grants.ts'
import { POLICY_REV } from '../permissions/policy.ts'
import { insertGrant } from '../permissions/test-support.ts'
import { claimStmt } from './claim.ts'
import { sendAction } from './dispatch.ts'
import { readGate, syncGate } from './gate.ts'
import { HOLD_LINES, holdOutbox, releaseHoldStmts } from './restore-hold.ts'
import { actionLine, newActionId } from './sql.ts'
import { ADMIN, ASKER, SHOP_GEN, fakeHub, fresh, notices, outbox, requestCtx, rowOf, tagArgs, world } from './test-support.ts'
import type { ActionState, OutboxActionRow } from './types.ts'

const db = env.DB
const T0 = 1_800_000_000_000
const STATES: readonly ActionState[] = ['waiting', 'approved', 'sending', 'sent', 'failed', 'needs_check', 'undone', 'denied', 'withdrawn', 'expired']
const SYSTEM = 'm_system'

beforeEach(async () => {
  await world(db)
})

/** One action row in `state`, written directly (the hold reads rows as a restore leaves them). */
async function insertRow(state: ActionState, attempt: number): Promise<string> {
  const id = newActionId()
  await db.prepare(
    `INSERT INTO outbox_actions (id, rev, state, verdict, origin, via, asked_by, approver, chat_id, account_id, account_gen, operation,
       policy_rev, scope_json, scope_key, args_json, payload_hash, records, units, card_json, approved_rev, attempt, expires_at_ms,
       created_at_ms, updated_at_ms)
     VALUES (?, 3, ?, 'ask', 'chat', 'tool', ?, ?, 'c_hold', 'shopify:store', ?, 'shopify.order.tag_add', ?, '{"shop":"store-a"}',
       'shop=store-a', '{}', ?, 1, 1, '{}', ?, ?, ?, ?, ?)`,
  ).bind(id, state, ASKER, ASKER, SHOP_GEN, POLICY_REV, fresh('h'), state === 'approved' ? 3 : 2, attempt, T0 + 86_400_000, T0, T0).run()
  return id
}

async function insertGrantRow(revoked: boolean): Promise<string> {
  const id = newPermissionId()
  await insertGrant(db, {
    id, holder: `member:${ASKER}`, accountId: 'shopify:store', accountGen: SHOP_GEN, operation: 'shopify.order.tag_add',
    scopeKey: `shop=${id.slice(3, 12).replace(/[^A-Za-z0-9]/g, 'x')}`, perDay: 5, policyRev: POLICY_REV, grantedRole: 'member', ceilingRev: 1,
    revokedAtMs: revoked ? T0 : null,
  })
  return id
}

const answerLine = (actionId: string, choice: 'once' | 'always' | 'approve' | 'deny') =>
  actionLine({ atMs: T0, actorId: ASKER, requestId: fresh('ans'), args: { action: 'action.answered', actionId, choice } }, null)
/** A live close after the backup: a withdraw or an expiry, at `atMs`. */
const closeLineOf = (actionId: string, kind: 'withdrawn' | 'expired', atMs: number) => actionLine({
  atMs, actorId: ASKER, requestId: fresh('cl'),
  args: kind === 'withdrawn' ? { action: 'action.withdrawn', actionId, by: 'member' } : { action: 'action.lapsed', actionId, reason: 'expired', released: false },
}, null)
const RESTORE_ID = '20271115T010203004Z-0a1b2c3d'
/** A restore id of its own: the audit log keeps every confirm line, so each H6 case confirms a restore no other case does. */
const newRestoreId = () => `20271115T010203004Z-${[...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join('')}`

const maxAuditId = async () => (await db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM audit_log').first<{ n: number }>())?.n ?? 0
const allRows = async (ids: readonly string[]) => (await db.prepare('SELECT * FROM outbox_actions WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id').bind(JSON.stringify(ids)).all<OutboxActionRow>()).results
const allGrants = async () => (await db.prepare('SELECT * FROM permission_grants ORDER BY id').all<Record<string, unknown>>()).results
const allUses = async () => (await db.prepare('SELECT * FROM permission_uses ORDER BY id').all()).results
const linesOf = async (requestId: string) => (await db.prepare('SELECT action, target_id, args_json FROM audit_log WHERE req_id = ? ORDER BY id').bind(requestId).all<{ action: string; target_id: string; args_json: string }>()).results

type Case = {
  rows: { state: ActionState; attempt: number; answer: 'none' | 'deny' | 'once' | 'always' | 'approve'; answeredAfter: boolean; closed: 'none' | 'withdrawn' | 'expired' }[]
  grants: boolean[]
  gap: boolean
  doGen: number
}

const caseArb: fc.Arbitrary<Case> = fc.record({
  rows: fc.array(fc.record({
    state: fc.constantFrom(...STATES), attempt: fc.integer({ min: 0, max: 3 }),
    answer: fc.constantFrom('none', 'deny', 'once', 'always', 'approve'), answeredAfter: fc.boolean(),
    closed: fc.constantFrom('none', 'none', 'withdrawn', 'expired'),
  }), { minLength: 1, maxLength: 8 }),
  grants: fc.array(fc.boolean(), { maxLength: 4 }),
  gap: fc.boolean(),
  doGen: fc.integer({ min: 0, max: 9 }),
})

describe('the hold (H1 to H5)', () => {
  it('holds exactly the rows that may have gone out, revokes every live grant, and a second run changes nothing', async () => {
    await fc.assert(fc.asyncProperty(caseArb, async c => {
      await world(db)
      await db.prepare('UPDATE outbox_gate SET do_gen = ?, epoch = 7 WHERE id = 1').bind(c.doGen).run()
      const ids: string[] = []
      for (const r of c.rows) ids.push(await insertRow(r.state, r.attempt))
      // Answer lines before the backup's audit id, then the mark, then the ones after it.
      for (const [i, r] of c.rows.entries()) if (r.answer !== 'none' && !r.answeredAfter) await runBatch(db, [answerLine(ids[i], r.answer)])
      const afterId = await maxAuditId()
      for (const [i, r] of c.rows.entries()) if (r.answer !== 'none' && r.answeredAfter) await runBatch(db, [answerLine(ids[i], r.answer)])
      for (const [i, r] of c.rows.entries()) if (r.closed !== 'none') await runBatch(db, [closeLineOf(ids[i], r.closed, T0 + 100 + i)])
      // A held row's use, as the request or the answer reserved it.
      for (const [i, r] of c.rows.entries()) {
        if (r.state !== 'approved' && r.state !== 'sending') continue
        const actionRev = r.state === 'approved' ? 3 : 2
        await db.prepare("INSERT INTO permission_uses (id, action_id, action_rev, grant_id, day, units, at_ms) VALUES (?, ?, ?, 'pg_AAAAAAAAAAAAAAAAAAAAAA', '2027-01-15', 1, ?)")
          .bind(`${ids[i]}#${actionRev}`, ids[i], actionRev, T0).run()
      }
      const grants: string[] = []
      for (const revoked of c.grants) grants.push(await insertGrantRow(revoked))
      const rowsBefore = await allRows(ids)
      const grantsBefore = await allGrants()
      const usesBefore = await allUses()
      const requestId = `restore:${fresh('r')}`
      const input = { restoreId: newRestoreId(), afterId, gap: c.gap, at: { nowMs: T0 + 5, actorId: SYSTEM, requestId } }

      const result = await holdOutbox(db, input)

      const closeTo = c.rows.map(r => r.state !== 'waiting' ? null
        : r.answeredAfter && r.answer === 'deny' ? 'denied' as const : r.closed === 'none' ? null : r.closed)
      const expectHeld = c.rows.map((r, i) => closeTo[i] === null && (r.state === 'approved' || r.state === 'sending'
        || (r.state === 'waiting' && (c.gap || (r.answeredAfter && (r.answer === 'once' || r.answer === 'always' || r.answer === 'approve'))))))
      const rowsAfter = await allRows(ids)
      const byId = new Map(rowsAfter.map(r => [r.id, r]))
      const before = new Map(rowsBefore.map(r => [r.id, r]))
      // H1
      expect(rowsAfter.filter(r => r.state === 'approved' || r.state === 'sending')).toEqual([])
      expect(await readGate(db)).toMatchObject({ restore_hold: 1, do_gen: -1, epoch: 8 })
      // H2
      for (const [i, id] of ids.entries()) {
        const a = byId.get(id) as OutboxActionRow
        const b = before.get(id) as OutboxActionRow
        const to = closeTo[i]
        if (to !== null) {
          const finalAt = to === 'denied' ? T0 : T0 + 100 + i
          expect(a, `waiting closed ${to}`).toEqual({ ...b, state: to, rev: b.rev + 1, final_at_ms: finalAt, lapsed_reason: to === 'expired' ? 'expired' : b.lapsed_reason, updated_at_ms: T0 + 5 })
        } else if (expectHeld[i]) expect(a, `${c.rows[i].state} held`).toMatchObject({ state: 'needs_check', rev: b.rev + 1, attempt: b.attempt, approved_rev: b.approved_rev })
        else expect(a, `${c.rows[i].state} untouched`).toEqual(b)
      }
      expect(result.held).toEqual(ids.filter((_, i) => expectHeld[i]).sort())
      // `closed`: every row in a final state an after-backup line names (one closed by this hold, or one that already was).
      const named = c.rows.map((r, i) => {
        const st = (byId.get(ids[i]) as OutboxActionRow).state
        return (st === 'denied' && r.answeredAfter && r.answer === 'deny') || (st === r.closed)
      })
      expect(result.closed).toEqual(ids.filter((_, i) => named[i]).sort())
      for (const [i, to] of closeTo.entries()) if (to !== null) expect(result.closed).toContain(ids[i])
      // H3
      const lines = await linesOf(requestId)
      for (const l of lines) expect(AuditArgsSchema.safeParse({ action: l.action, ...JSON.parse(l.args_json) }).success, l.args_json).toBe(true)
      const checks = lines.filter(l => l.action === 'action.needs_check')
      expect(checks.map(l => l.target_id).sort()).toEqual(result.held)
      for (const l of checks) {
        const b = before.get(l.target_id) as OutboxActionRow
        expect(JSON.parse(l.args_json)).toEqual(b.attempt > 0 ? { actionId: b.id, attempt: b.attempt, why: 'restore' } : { actionId: b.id, why: 'restore' })
      }
      // H4
      const live = c.grants.map((revoked, i) => (revoked ? null : grants[i])).filter((g): g is string => g !== null).sort()
      expect(result.revoked).toEqual(live)
      expect(lines.filter(l => l.action === 'permission.revoked').map(l => [l.target_id, JSON.parse(l.args_json).reason])).toEqual(live.map(g => [g, 'restore']))
      for (const g of await allGrants()) {
        const b = grantsBefore.find(x => x.id === g.id) as Record<string, unknown>
        if (b.revoked_at_ms === null) expect(g).toMatchObject({ revoked_at_ms: T0 + 5, revoke_reason: 'restore', revoked_by: SYSTEM })
        else expect(g).toEqual(b)
      }
      // H5
      expect(usesBefore.length).toBe(c.rows.filter(r => r.state === 'approved' || r.state === 'sending').length)
      expect(await allUses()).toEqual(usesBefore)
      const grantsAfter = await allGrants()
      expect(await holdOutbox(db, { ...input, at: { ...input.at, nowMs: T0 + 6 } })).toEqual(result)
      expect(await allRows(ids)).toEqual(rowsAfter)
      expect(await allGrants()).toEqual(grantsAfter)
      expect(await linesOf(requestId)).toEqual(lines)
      expect(await readGate(db)).toMatchObject({ restore_hold: 1, do_gen: -1 })
    }), { numRuns: 40 })
  })

  it('changes nothing once this restore is confirmed (H7)', async () => {
    const waiting = await insertRow('waiting', 0)
    const approved = await insertRow('approved', 0)
    const afterId = await maxAuditId()
    await runBatch(db, [answerLine(waiting, 'once')])
    const grant = await insertGrantRow(false)
    await runBatch(db, [auditInsert({ atMs: T0, actorId: SYSTEM, args: { action: 'restore.confirmed', restoreId: RESTORE_ID, backupId: RESTORE_ID, approvedBy: ADMIN }, target: null, requestId: fresh('c') }, null)])
    const gate = await readGate(db)
    const rows = await allRows([waiting, approved])
    const grants = await allGrants()
    const requestId = `restore:${RESTORE_ID}`
    expect(await holdOutbox(db, { restoreId: RESTORE_ID, afterId, gap: true, at: { nowMs: T0 + 5, actorId: SYSTEM, requestId } })).toEqual({ held: [], revoked: [], closed: [] })
    expect(await readGate(db)).toEqual(gate)
    expect(await allRows([waiting, approved])).toEqual(rows)
    expect(await allGrants()).toEqual(grants)
    expect(grants.map(g => g.id)).toEqual([grant])
    expect(await linesOf(requestId)).toEqual([])
    // Another restore's confirm doesn't stop this one.
    expect((await holdOutbox(db, { restoreId: '20271115T010203004Z-ffffffff', afterId, gap: false, at: { nowMs: T0 + 6, actorId: SYSTEM, requestId } })).held).toEqual([approved, waiting].sort())
  })

  it('the re-append exempts the hold\'s two line kinds under its request id, and nothing else (H8)', async () => {
    const actionId = await insertRow('waiting', 0)
    const grantId = newPermissionId()
    const mine = `restore:${newRestoreId()}`
    const line = (requestId: string, args: Parameters<typeof actionLine>[0]['args']) => actionLine({ atMs: T0, actorId: SYSTEM, requestId, args }, null)
    const from = await maxAuditId()
    await runBatch(db, [
      line(mine, { action: 'action.needs_check', actionId, why: 'restore' }),
      line(mine, { action: 'action.needs_check', actionId, attempt: 1, why: 'stale' }),
      line(mine, { action: 'action.lapsed', actionId, reason: 'restore_hold', released: false }),
      line(fresh('other'), { action: 'action.needs_check', actionId, why: 'restore' }),
      auditInsert({ atMs: T0, actorId: SYSTEM, args: { action: 'permission.revoked', permissionId: grantId, operation: 'shopify.order.tag_add', reason: 'restore' }, target: null, requestId: mine }, null),
      auditInsert({ atMs: T0, actorId: SYSTEM, args: { action: 'permission.revoked', permissionId: grantId, operation: 'shopify.order.tag_add', reason: 'removed' }, target: null, requestId: mine }, null),
    ])
    const matched = (await db.prepare(`SELECT id - ? AS n FROM audit_log WHERE id > ? AND ${HOLD_LINES} ORDER BY id`).bind(from, from, mine).all<{ n: number }>()).results.map(r => r.n)
    expect(matched).toEqual([1, 5])
  })
})

describe('while held, and after the release (H6)', () => {
  const now = { t: T0 }
  const clock = () => now.t
  let restoreId = newRestoreId()
  beforeEach(() => { restoreId = newRestoreId() })
  const hold = (requestId = `restore:${fresh('r')}`) => holdOutbox(db, { restoreId, afterId: 0, gap: false, at: { nowMs: now.t, actorId: SYSTEM, requestId } })
  const confirmLine = (restoreId: string) => auditInsert({
    atMs: now.t, actorId: SYSTEM, args: { action: 'restore.confirmed', restoreId, backupId: restoreId, approvedBy: ADMIN }, target: null, requestId: fresh('c'),
  }, null)
  const sync = (pauseGen: number, paused = false) => syncGate({ db, state: () => ({ paused, pauseGen }), nowMs: now.t, requestId: fresh('sync'), notify: notices().notify })
  const ask = async (order: number) => {
    const r = await outbox(db, clock).request(requestCtx({ nowMs: now.t }), { operation: 'shopify.order.tag_add', args: tagArgs(order) }, { mode: 'tool' })
    if (r.outcome !== 'waiting') throw new Error(`expected a card, got ${r.outcome}`)
    return r.action
  }

  it('a gate ahead of a fresh object never moves on its own; after the hold the first sync re-seats it (the #433 carry-over)', async () => {
    await db.prepare('UPDATE outbox_gate SET do_gen = 4 WHERE id = 1').run()
    // A fresh BrandAgent: generation 0. The forward-only sync can't move a gate at 4.
    expect(await sync(0)).toMatchObject({ moved: false })
    expect(await readGate(db)).toMatchObject({ do_gen: 4 })
    await hold()
    expect(await sync(0)).toMatchObject({ moved: true })
    expect(await readGate(db)).toMatchObject({ do_gen: 0, restore_hold: 1 })
  })

  it('a Pause and a Resume re-seat the gate but never lift the hold; answers and claims are refused until the release', async () => {
    now.t = T0
    const a = await ask(1)
    await hold()
    for (const [gen, paused] of [[1, true], [2, false]] as const) {
      await sync(gen, paused)
      expect(await readGate(db)).toMatchObject({ restore_hold: 1, do_gen: gen, paused: paused ? 1 : 0 })
    }
    const refused = await outbox(db, clock).answer({ memberId: ASKER, role: 'member' }, a.id, { choice: 'once', ifRev: a.rev })
    expect(refused).toMatchObject({ refused: { code: 'conflict' } })
    expect(await rowOf(db, a.id)).toMatchObject({ state: 'waiting' })
    // A release with no confirm line changes nothing.
    await runBatch(db, releaseHoldStmts({ restoreId, nowMs: now.t }))
    expect(await readGate(db)).toMatchObject({ restore_hold: 1 })
    // The confirm's batch: its line, then the release.
    await runBatch(db, [confirmLine(restoreId), ...releaseHoldStmts({ restoreId, nowMs: now.t })])
    // The release sets `do_gen` back to -1: the syncs made while held count for nothing.
    expect(await readGate(db)).toMatchObject({ restore_hold: 0, do_gen: -1 })
    const hub = fakeHub(db, () => 'ok')
    const send = () => sendAction(a.id, { db, nowMs: now.t, hub: hub.gateway, notify: notices().notify, requestId: fresh('send'), again: () => {}, gate: { paused: false, pauseGen: 2 }, timeoutMs: 5 })
    const approve = async () => {
      const row = await rowOf(db, a.id)
      const ok = await outbox(db, clock).answer({ memberId: ASKER, role: 'member' }, a.id, { choice: 'once', ifRev: row?.rev ?? 0 })
      if (!('action' in ok)) throw new Error(`answer refused: ${ok.refused.code}`)
    }
    // Before any sync: the answer goes through, the claim is refused and the approval lapses, with no call.
    await approve()
    now.t += 10_000
    expect(await send()).toEqual({ kind: 'not_claimed' })
    expect(await rowOf(db, a.id)).toMatchObject({ state: 'waiting', lapsed_reason: 'paused' })
    await sync(2)
    expect(await readGate(db)).toMatchObject({ restore_hold: 0, do_gen: 2 })
    await approve()
    now.t += 10_000
    expect(await send()).toMatchObject({ kind: 'sent' })
    expect(hub.calls.map(c => [c.req.actionId, c.violation])).toEqual([[a.id, null]])
  })

  it('no claim wins while held, at any generation', async () => {
    now.t = T0
    const a = await ask(2)
    const ok = await outbox(db, clock).answer({ memberId: ASKER, role: 'member' }, a.id, { choice: 'once', ifRev: a.rev })
    if (!('action' in ok)) throw new Error(`answer refused: ${ok.refused.code}`)
    // A hold that left a row approved would still be refused by the gate: put one back by hand to prove the claim's own check.
    await hold()
    await db.prepare("UPDATE outbox_actions SET state = 'approved', rev = approved_rev WHERE id = ?").bind(a.id).run()
    await db.prepare('UPDATE outbox_gate SET epoch = (SELECT approved_epoch FROM outbox_actions WHERE id = ?)').bind(a.id).run()
    now.t += 10_000
    for (const gen of [-1, 0, 1, 7]) {
      await runBatch(db, [claimStmt({ actionId: a.id, nowMs: now.t, pauseGen: gen, stamp: fresh('claim') })])
      expect((await rowOf(db, a.id))?.state, `gen ${gen}`).toBe('approved')
    }
  })
})
