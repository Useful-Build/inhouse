// The restore hold on real D1 (M2-R, N12): the batch the reconcile's step 4 runs, and the confirm's release. The real
// restore of a backup, end to end, is ops/backup/reconcile/hold.test.ts. Invariants, written before the code:
//  H1. after the hold, no row is `approved` or `sending`, the gate is held at `do_gen = -1` and its epoch moved on;
//  H2. a row goes to `needs_check` exactly when it was `approved` or `sending`, or `waiting` with an approving answer
//      line above the backup's audit id (any `waiting` row when lines were lost); every other row is untouched;
//  H3. each held row has exactly one `action.needs_check` line (`why: 'restore'`, its attempt when it had one) under
//      the restore's request id, and every line the hold writes parses against the audit schema;
//  H4. no grant is live after it; each grant that was live has exactly one `permission.revoked` line (`restore`); a
//      grant revoked before keeps its own revoke;
//  H5. uses are untouched; a second run changes no row, grant or line;
//  H6. while held, a sync (a Resume, a sweep) re-seats `do_gen` but never clears the hold, an answer is refused and no
//      claim wins; only the release (under a `restore.confirmed` line) clears it, and then an approval is claimed.
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
import { holdOutbox, releaseHoldStmts } from './restore-hold.ts'
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

const maxAuditId = async () => (await db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM audit_log').first<{ n: number }>())?.n ?? 0
const allRows = async (ids: readonly string[]) => (await db.prepare('SELECT * FROM outbox_actions WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id').bind(JSON.stringify(ids)).all<OutboxActionRow>()).results
const allGrants = async () => (await db.prepare('SELECT * FROM permission_grants ORDER BY id').all<Record<string, unknown>>()).results
const allUses = async () => (await db.prepare('SELECT * FROM permission_uses ORDER BY id').all()).results
const linesOf = async (requestId: string) => (await db.prepare('SELECT action, target_id, args_json FROM audit_log WHERE req_id = ? ORDER BY id').bind(requestId).all<{ action: string; target_id: string; args_json: string }>()).results

type Case = {
  rows: { state: ActionState; attempt: number; answer: 'none' | 'deny' | 'once' | 'approve'; answeredAfter: boolean }[]
  grants: boolean[]
  gap: boolean
  doGen: number
}

const caseArb: fc.Arbitrary<Case> = fc.record({
  rows: fc.array(fc.record({
    state: fc.constantFrom(...STATES), attempt: fc.integer({ min: 0, max: 3 }),
    answer: fc.constantFrom('none', 'deny', 'once', 'approve'), answeredAfter: fc.boolean(),
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
      const grants: string[] = []
      for (const revoked of c.grants) grants.push(await insertGrantRow(revoked))
      const rowsBefore = await allRows(ids)
      const grantsBefore = await allGrants()
      const usesBefore = await allUses()
      const requestId = `restore:${fresh('r')}`
      const input = { afterId, gap: c.gap, at: { nowMs: T0 + 5, actorId: SYSTEM, requestId } }

      const result = await holdOutbox(db, input)

      const expectHeld = c.rows.map(r => r.state === 'approved' || r.state === 'sending'
        || (r.state === 'waiting' && (c.gap || (r.answeredAfter && (r.answer === 'once' || r.answer === 'approve')))))
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
        if (expectHeld[i]) expect(a, `${c.rows[i].state} held`).toMatchObject({ state: 'needs_check', rev: b.rev + 1, attempt: b.attempt, approved_rev: b.approved_rev })
        else expect(a, `${c.rows[i].state} untouched`).toEqual(b)
      }
      expect(result.held).toEqual(ids.filter((_, i) => expectHeld[i]).sort())
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
      expect(await allUses()).toEqual(usesBefore)
      const grantsAfter = await allGrants()
      expect(await holdOutbox(db, { ...input, at: { ...input.at, nowMs: T0 + 6 } })).toEqual(result)
      expect(await allRows(ids)).toEqual(rowsAfter)
      expect(await allGrants()).toEqual(grantsAfter)
      expect(await linesOf(requestId)).toEqual(lines)
      expect(await readGate(db)).toMatchObject({ restore_hold: 1, do_gen: -1 })
    }), { numRuns: 40 })
  })
})

describe('while held, and after the release (H6)', () => {
  const now = { t: T0 }
  const clock = () => now.t
  const hold = (requestId = `restore:${fresh('r')}`) => holdOutbox(db, { afterId: 0, gap: false, at: { nowMs: now.t, actorId: SYSTEM, requestId } })
  const confirmLine = (restoreId: string) => auditInsert({
    atMs: now.t, actorId: SYSTEM, args: { action: 'restore.confirmed', restoreId, backupId: restoreId, approvedBy: ADMIN }, target: null, requestId: fresh('c'),
  }, null)
  const RESTORE_ID = '20271115T010203004Z-0a1b2c3d'
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
    await runBatch(db, releaseHoldStmts({ restoreId: RESTORE_ID, nowMs: now.t }))
    expect(await readGate(db)).toMatchObject({ restore_hold: 1 })
    // The confirm's batch: its line, then the release.
    await runBatch(db, [confirmLine(RESTORE_ID), ...releaseHoldStmts({ restoreId: RESTORE_ID, nowMs: now.t })])
    expect(await readGate(db)).toMatchObject({ restore_hold: 0, do_gen: 2 })
    const ok = await outbox(db, clock).answer({ memberId: ASKER, role: 'member' }, a.id, { choice: 'once', ifRev: a.rev })
    if (!('action' in ok)) throw new Error(`answer refused: ${ok.refused.code}`)
    now.t += 10_000
    const hub = fakeHub(db, () => 'ok')
    const sent = await sendAction(a.id, { db, nowMs: now.t, hub: hub.gateway, notify: notices().notify, requestId: fresh('send'), again: () => {}, gate: { paused: false, pauseGen: 2 }, timeoutMs: 5 })
    expect(sent).toMatchObject({ kind: 'sent' })
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
