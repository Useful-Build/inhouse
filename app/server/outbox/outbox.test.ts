// The outbox's unit cases on real D1 (M2-B "Tests"; P6 acceptance 1 to 6, 8 and 9, item 3 without the retry). Ways it
// can fail, written down first:
//  1. `request` writes on a refusal, makes a second card for a retry or a second row for a replayed invocation, accepts
//     other arguments under the same invocation, runs an `approval_request`, or returns `run` with no use reserved;
//  2. an answer: two answers to one revision both win; a stale revision, a paused gate or another member approves; an
//     exact card takes "Always allow"; a routine's card takes anything but an exact approval; "Always allow" makes no
//     grant, two grants, or a grant without the action's use;
//  3. Undo after the claim wins, or Undo keeps the use;
//  4. a revoke, a role drop, a disconnected account, a lowered ceiling or a Pause during the hold still sends, or the
//     card doesn't say why; an asker who left still sends;
//  5. a result: a definite refusal isn't `failed` with its use released; an unclear one (unsure, a throw, a timeout, a
//     garbled answer) isn't `needs_check`; anything is retried; no binding sends or stays approved;
//  6. "Needs a check" is resolved by someone other than the approver or an admin, isn't audited, or "it didn't go out"
//     keeps the use; a late result overrides a person's answer;
//  7. the sweep claims a lost row twice, touches a `sending` row except to make it a check, misses a stale one or an
//     expired card, or leaves the gate out of step;
//  8. an audit line holds an argument, or is written when its change didn't apply.
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { AuditArgsSchema } from '../../shared/contract/audit.ts'
import { answerAction, getAction, listActions, resolveAction, undoAction } from '../api/actions.ts'
import { openStores } from '../db/stores.ts'
import { lastLineId, linesSince, personPrincipal, ctx as handlerCtx } from '../db/test-support.ts'
import { setCeilingStmt } from '../permissions/ceiling.ts'
import { POLICY_REV } from '../permissions/policy.ts'
import { channel, insertGrant, person } from '../permissions/test-support.ts'
import { runBatch } from '../db/sql.ts'
import { cardOf } from './card.ts'
import { claimStmt } from './claim.ts'
import { sendAction } from './dispatch.ts'
import type { DispatchDeps } from './dispatch.ts'
import { syncGate } from './gate.ts'
import { sweepOutbox } from './sweep.ts'
import {
  ADMIN, ASKER, OTHER, SHOP_GEN, fakeHub, fresh, notices, outbox, requestCtx, rowOf, tagArgs, unreleasedUses, world,
} from './test-support.ts'
import type { HubMode } from './test-support.ts'
import type { OutboxActionRow } from './types.ts'

const db = env.DB
const T0 = 1_800_000_000_000
let now = T0
const clock = () => now
const ASKER_ACTOR = { memberId: ASKER, role: 'member' as const }

beforeEach(async () => {
  now = T0
  await world(db)
})

const grant = async (o: { perDay?: number } = {}) => {
  const id = `pg_${fresh('g').replace(/[^A-Za-z0-9]/g, '').padEnd(22, 'A').slice(0, 22)}`
  await insertGrant(db, {
    id, holder: `member:${ASKER}`, accountId: 'shopify:store', accountGen: SHOP_GEN, operation: 'shopify.order.tag_add', scopeKey: 'shop=store-a',
    perDay: o.perDay ?? 5, policyRev: POLICY_REV, grantedRole: 'member', ceilingRev: 1, revokedAtMs: null,
  })
  return id
}
const ask = async (order = 1, o: Partial<Parameters<typeof requestCtx>[0]> = {}, mode: 'tool' | 'ask_only' = 'tool') =>
  outbox(db, clock).request(requestCtx({ nowMs: now, ...o }), { operation: 'shopify.order.tag_add', args: tagArgs(order) }, { mode })
const waitingId = async (order = 1) => {
  const r = await ask(order)
  if (r.outcome !== 'waiting') throw new Error(`expected a card, got ${r.outcome}`)
  return r.action
}
const approved = async (order = 1) => {
  const a = await waitingId(order)
  const r = await outbox(db, clock).answer(ASKER_ACTOR, a.id, { choice: 'once', ifRev: a.rev })
  if (!('action' in r)) throw new Error(`answer refused: ${r.refused.code}`)
  return r.action
}
const dispatch = (id: string, o: Partial<DispatchDeps> & { mode?: HubMode } = {}) => {
  const hub = fakeHub(db, () => o.mode ?? 'ok')
  const note = notices()
  const object = { paused: false, pauseGen: 0 }
  const run = sendAction(id, { db, nowMs: now, hub: hub.gateway, notify: note.notify, requestId: fresh('send'), again: () => {}, gate: object, timeoutMs: 5, ...o })
  return { run, hub, note }
}
/** Every line since `mark`, parsed by the reader's schema (none may be one it refuses). */
const parsedSince = async (mark: number) => (await linesSince(db, mark)).map(l => ({ ...AuditArgsSchema.parse({ action: l.action, ...JSON.parse(l.args_json) }), target: [l.target_kind, l.target_id] }))

describe('request (failure 1)', () => {
  it('writes nothing on a refusal, and says why in plain words', async () => {
    await runBatch(db, [setCeilingStmt({ operation: 'shopify.order.tag_add', enabled: false, perDayMax: 50, actorId: 'm_system', nowMs: now })])
    const mark = await lastLineId(db)
    const r = await ask()
    expect(r).toEqual({ outcome: 'refused', reason: 'over_ceiling', text: expect.stringContaining('turned off') })
    expect((await db.prepare('SELECT COUNT(*) AS n FROM outbox_actions').first<{ n: number }>())?.n).toBe(0)
    expect(await linesSince(db, mark)).toEqual([])
    const bad = await outbox(db, clock).request(requestCtx({ nowMs: now }), { operation: 'shopify.order.tag_add', args: { orderId: 'x', tags: [] } }, { mode: 'tool' })
    expect(bad).toMatchObject({ outcome: 'refused', reason: 'invalid_args' })
    const system = await outbox(db, clock).request(requestCtx({ nowMs: now, asker: null }), { operation: 'shopify.order.tag_add', args: tagArgs(1) }, { mode: 'tool' })
    expect(system).toMatchObject({ outcome: 'refused', reason: 'over_ceiling' })
  })

  it('makes one card per payload in a chat, and returns a replayed invocation as it is', async () => {
    const first = await ask(1, { invocation: { runId: 'r_1', turnId: 't_1', toolUseId: 'tu_same' } })
    expect(first).toMatchObject({ outcome: 'waiting', existing: false })
    const retry = await ask(1)
    expect(retry).toMatchObject({ outcome: 'waiting', existing: true })
    expect(retry.outcome === 'waiting' && first.outcome === 'waiting' && retry.action.id === first.action.id).toBe(true)
    const replay = await ask(1, { invocation: { runId: 'r_1', turnId: 't_1', toolUseId: 'tu_same' } })
    expect(replay).toMatchObject({ outcome: 'existing' })
    const other = await ask(2, { invocation: { runId: 'r_1', turnId: 't_1', toolUseId: 'tu_same' } })
    expect(other).toMatchObject({ outcome: 'refused', reason: 'invocation_conflict' })
    expect((await db.prepare('SELECT COUNT(*) AS n FROM outbox_actions').first<{ n: number }>())?.n).toBe(1)
  })

  it('runs under a live grant with its use reserved, and an `approval_request` never runs', async () => {
    const g = await grant()
    const mark = await lastLineId(db)
    const r = await ask(1)
    expect(r.outcome).toBe('approved')
    if (r.outcome !== 'approved') return
    expect(r.action).toMatchObject({ state: 'approved', verdict: 'run', grant_id: g, approved_by: `grant:${g}`, approved_rev: 1, send_at_ms: T0 + 10_000 })
    expect(await unreleasedUses(db, r.action.id)).toEqual([expect.objectContaining({ grant_id: g, action_rev: 1, units: 1 })])
    expect(await parsedSince(db === env.DB ? mark : 0)).toEqual([
      expect.objectContaining({ action: 'action.requested', verdict: 'run', permissionId: g, target: ['action', r.action.id] }),
    ])
    const asked = await ask(2, {}, 'ask_only')
    expect(asked).toMatchObject({ outcome: 'waiting', action: { verdict: 'ask', via: 'approval_request' } })
  })

  it("a grant whose day is spent gives an exact approval (guardrail `count`), never `run` and never `ask`", async () => {
    await grant({ perDay: 1 })
    expect((await ask(1)).outcome).toBe('approved')
    const second = await ask(2)
    expect(second).toMatchObject({ outcome: 'waiting', action: { verdict: 'exact', guardrail: 'count' } })
  })

  it('a run while the gate is closed leaves a card and no use', async () => {
    await grant()
    await db.prepare('UPDATE outbox_gate SET paused = 1').run()
    const r = await ask(1)
    expect(r).toMatchObject({ outcome: 'waiting', action: { verdict: 'ask' } })
    expect((await db.prepare('SELECT COUNT(*) AS n FROM permission_uses').first<{ n: number }>())?.n).toBe(0)
  })
})

describe('answers (failure 2)', () => {
  it('two answers to one revision: one wins; a stale revision loses', async () => {
    const a = await waitingId()
    const port = outbox(db, clock)
    const both = await Promise.all([port.answer(ASKER_ACTOR, a.id, { choice: 'once', ifRev: 1 }), port.answer(ASKER_ACTOR, a.id, { choice: 'deny', ifRev: 1 })])
    expect(both.filter(b => 'action' in b)).toHaveLength(1)
    expect(both.filter(b => 'refused' in b)).toEqual([{ refused: { code: 'conflict' } }])
  })

  it('only the approver answers; a paused gate refuses an approval but not a No', async () => {
    const a = await waitingId()
    expect(await outbox(db, clock).answer({ memberId: OTHER, role: 'member' }, a.id, { choice: 'once', ifRev: 1 })).toEqual({ refused: { code: 'not_found' } })
    expect(await outbox(db, clock).answer({ memberId: ADMIN, role: 'admin' }, a.id, { choice: 'once', ifRev: 1 })).toEqual({ refused: { code: 'forbidden', reason: 'not_owner' } })
    await db.prepare('UPDATE outbox_gate SET paused = 1').run()
    expect(await outbox(db, clock).answer(ASKER_ACTOR, a.id, { choice: 'once', ifRev: 1 })).toEqual({ refused: { code: 'conflict', reason: 'paused' } })
    expect(await outbox(db, clock).answer(ASKER_ACTOR, a.id, { choice: 'deny', ifRev: 1 })).toMatchObject({ action: { state: 'denied' } })
  })

  it('"Always allow" makes one grant, reserves this revision\'s use under it and sets the action\'s grant', async () => {
    const a = await waitingId()
    const mark = await lastLineId(db)
    const r = await outbox(db, clock).answer(ASKER_ACTOR, a.id, { choice: 'always', ifRev: 1 })
    expect('action' in r).toBe(true)
    if (!('action' in r)) return
    const live = await db.prepare('SELECT id FROM permission_grants WHERE revoked_at_ms IS NULL').all<{ id: string }>()
    expect(live.results).toHaveLength(1)
    expect(r.action).toMatchObject({ state: 'approved', rev: 2, approved_rev: 2, grant_id: live.results[0].id, approved_by: ASKER })
    expect(await unreleasedUses(db, a.id)).toEqual([expect.objectContaining({ grant_id: live.results[0].id, action_rev: 2 })])
    const lines = await parsedSince(mark)
    expect(lines.map(l => l.action)).toEqual(['permission.granted', 'action.answered'])
    expect(lines[1]).toMatchObject({ choice: 'always', permissionId: live.results[0].id })
    // The next request in the same scope runs under it, with no second grant.
    expect(await ask(2)).toMatchObject({ outcome: 'approved', action: { grant_id: live.results[0].id } })
    expect((await db.prepare('SELECT COUNT(*) AS n FROM permission_grants').first<{ n: number }>())?.n).toBe(1)
  })

  it('an exact card takes only Approve or No; a routine\'s card is exact', async () => {
    await grant({ perDay: 1 })
    await ask(1)
    const exact = await waitingId(2)
    expect(exact.verdict).toBe('exact')
    expect(await outbox(db, clock).answer(ASKER_ACTOR, exact.id, { choice: 'always', ifRev: 1 })).toEqual({ refused: { code: 'invalid' } })
    expect(await outbox(db, clock).answer(ASKER_ACTOR, exact.id, { choice: 'once', ifRev: 1 })).toEqual({ refused: { code: 'invalid' } })
    expect(await outbox(db, clock).answer(ASKER_ACTOR, exact.id, { choice: 'approve', ifRev: 1 })).toMatchObject({ action: { state: 'approved' } })
    const routine = await ask(3, { origin: 'routine' })
    if (routine.outcome !== 'waiting') throw new Error('expected a card')
    expect(cardOf(routine.action, ASKER_ACTOR, now)).toMatchObject({ kind: 'exact', can: { approve: true, allowOnce: false, alwaysAllow: false } })
    expect(await outbox(db, clock).answer(ASKER_ACTOR, routine.action.id, { choice: 'always', ifRev: 1 })).toEqual({ refused: { code: 'invalid' } })
    expect(await outbox(db, clock).answer(ASKER_ACTOR, routine.action.id, { choice: 'approve', ifRev: 1 })).toMatchObject({ action: { state: 'approved', grant_id: null } })
  })
})

describe('Undo (failure 3)', () => {
  it('before the claim: undone, its use released; after the claim: conflict', async () => {
    await grant()
    const r = await ask(1)
    if (r.outcome !== 'approved') throw new Error('expected a run')
    const undone = await outbox(db, clock).undo(ASKER_ACTOR, r.action.id, { ifRev: 1 })
    expect(undone).toMatchObject({ action: { state: 'undone' } })
    expect(await unreleasedUses(db, r.action.id)).toEqual([])
    await db.prepare('UPDATE permission_grants SET revoked_at_ms = ?').bind(now).run()
    const b = await approved(2)
    now += 10_000
    await runBatch(db, [claimStmt({ actionId: b.id, nowMs: now, pauseGen: 0, stamp: fresh('claim') })])
    expect(await outbox(db, clock).undo(ASKER_ACTOR, b.id, { ifRev: b.rev })).toEqual({ refused: { code: 'conflict' } })
  })
})

describe('the claim during the hold (failure 4)', () => {
  const lapsedBy = async (change: () => Promise<unknown>, reason: string, state = 'waiting') => {
    const g = await grant()
    const r = await ask(1)
    if (r.outcome !== 'approved') throw new Error('expected a run')
    expect(r.action.grant_id).toBe(g)
    await change()
    now += 10_000
    const d = dispatch(r.action.id)
    expect(await d.run).toEqual({ kind: 'not_claimed' })
    expect(d.hub.calls).toEqual([])
    const after = (await rowOf(db, r.action.id))!
    expect(after).toMatchObject({ state, lapsed_reason: reason, grant_id: null, approved_rev: null })
    expect(await unreleasedUses(db, r.action.id)).toEqual([])
    if (state === 'waiting') {
      expect(cardOf(after, ASKER_ACTOR, now).lapsed).toEqual(expect.any(String))
      expect(d.note.list).toEqual([expect.objectContaining({ kind: 'approval_lapsed', to: ASKER, actionId: r.action.id })])
    }
  }

  it('a removed permission stops the send and the card says why', () => lapsedBy(
    () => db.prepare('UPDATE permission_grants SET revoked_at_ms = ?').bind(now).run(), 'permission_removed'))

  it("a role drop (the grant was an admin's) stops it", async () => {
    await person(db, ASKER, 'admin')
    await lapsedBy(async () => {
      await db.prepare("UPDATE permission_grants SET granted_role = 'admin'").run()
      await person(db, ASKER, 'member')
    }, 'permission_removed')
  })

  it('a lowered ceiling stops it', () => lapsedBy(
    () => runBatch(db, [setCeilingStmt({ operation: 'shopify.order.tag_add', enabled: false, perDayMax: 50, actorId: 'm_system', nowMs: now })]), 'over_ceiling'))

  it('a reconnected account stops it', () => lapsedBy(
    () => db.prepare('UPDATE connector_accounts SET connected_at_ms = ?').bind(SHOP_GEN + 1).run(), 'account_changed'))

  it('a Pause lapses it at once: back to waiting, its use released, the approver told; resuming sends nothing', async () => {
    await grant()
    const r = await ask(1)
    if (r.outcome !== 'approved') throw new Error('expected a run')
    const told = notices()
    await syncGate({ db, state: { paused: true, pauseGen: 1 }, nowMs: now, requestId: fresh('sync'), notify: told.notify })
    expect(await rowOf(db, r.action.id)).toMatchObject({ state: 'waiting', lapsed_reason: 'paused', grant_id: null })
    expect(await unreleasedUses(db, r.action.id)).toEqual([])
    expect(told.list).toEqual([expect.objectContaining({ kind: 'approval_lapsed', to: ASKER, actionId: r.action.id })])
    await syncGate({ db, state: { paused: false, pauseGen: 2 }, nowMs: now, requestId: fresh('sync'), notify: told.notify })
    now += 10_000
    const d = dispatch(r.action.id, { gate: { paused: false, pauseGen: 2 } })
    expect(await d.run).toEqual({ kind: 'not_claimed' })
    expect(d.hub.calls).toEqual([])
  })

  it('a Pause and a Resume whose hooks both failed: the claim is refused and the approval lapses', async () => {
    await grant()
    const r = await ask(1)
    if (r.outcome !== 'approved') throw new Error('expected a run')
    now += 10_000
    // The object paused and resumed (generation 2); the gate never heard (do_gen 0).
    const d = dispatch(r.action.id, { gate: { paused: false, pauseGen: 2 } })
    expect(await d.run).toEqual({ kind: 'not_claimed' })
    expect(d.hub.calls).toEqual([])
    expect(await rowOf(db, r.action.id)).toMatchObject({ state: 'waiting', lapsed_reason: 'paused' })
  })

  it('an asker who left the team: withdrawn, never sent', () => lapsedBy(() => person(db, ASKER, 'member', 'removed'), 'asker_removed', 'withdrawn'))
})

describe('the result (failure 5)', () => {
  const sendWith = async (mode: HubMode) => {
    await grant()
    const r = await ask(1)
    if (r.outcome !== 'approved') throw new Error('expected a run')
    now += 10_000
    const d = dispatch(r.action.id, { mode })
    const out = await d.run
    return { id: r.action.id, out, d, row: (await rowOf(db, r.action.id))! }
  }

  it('ok: sent, the safe ref on the card, the use kept, one call', async () => {
    const s = await sendWith('ok')
    expect(s.out).toEqual({ kind: 'sent', ref: 'vip' })
    expect(s.row).toMatchObject({ state: 'sent', attempt: 1 })
    expect(cardOf(s.row, ASKER_ACTOR, now).result).toBe('Sent. vip')
    expect(await unreleasedUses(db, s.id)).toHaveLength(1)
    expect(s.d.hub.calls).toHaveLength(1)
    expect(s.d.hub.calls[0].violation).toBeNull()
    expect(s.d.hub.calls[0].req).toMatchObject({ actionId: s.id, attempt: 1, accountId: 'shopify:store', expect: { connectedAtMs: SHOP_GEN }, operation: 'shopify.order.tag_add' })
  })

  it('a definite refusal: failed, the use released', async () => {
    const s = await sendWith('no')
    expect(s.row).toMatchObject({ state: 'failed', error_code: 'upstream_rejected' })
    expect(await unreleasedUses(db, s.id)).toEqual([])
  })

  for (const [mode, why] of [['unknown', 'unknown'], ['throw', 'thrown'], ['bad', 'bad_result'], ['hang', 'timeout']] as const) {
    it(`${mode}: needs a check (${why}), the approver told, no retry`, async () => {
      const mark = await lastLineId(db)
      const s = await sendWith(mode)
      expect(s.out).toEqual({ kind: 'needs_check', why })
      expect(s.row.state).toBe('needs_check')
      expect(await unreleasedUses(db, s.id)).toHaveLength(1)
      expect(s.d.note.list).toEqual([expect.objectContaining({ kind: 'needs_check', to: ASKER })])
      expect((await parsedSince(mark)).find(l => l.action === 'action.needs_check')).toMatchObject({ why, attempt: 1 })
      // Dispatching again sends nothing: the row isn't approved.
      const again = dispatch(s.id)
      expect(await again.run).toEqual({ kind: 'not_claimed' })
      expect(again.hub.calls).toEqual([])
    })
  }

  it('no write binding: failed `not_configured`, nothing sent, the use released', async () => {
    await grant()
    const r = await ask(1)
    if (r.outcome !== 'approved') throw new Error('expected a run')
    now += 10_000
    expect(await dispatch(r.action.id, { hub: null }).run).toEqual({ kind: 'failed', code: 'not_configured' })
    expect(await rowOf(db, r.action.id)).toMatchObject({ state: 'failed', error_code: 'not_configured' })
    expect(await unreleasedUses(db, r.action.id)).toEqual([])
  })

  it('before the hold ends: not claimed, its task asked again for the hold\'s end', async () => {
    const a = await approved()
    const again: number[] = []
    const d = dispatch(a.id, { again: at => again.push(at) })
    expect(await d.run).toEqual({ kind: 'not_claimed' })
    expect(again).toEqual([T0 + 10_000])
    expect(d.hub.calls).toEqual([])
  })

  it('a Slack post names the listed channel by its id', async () => {
    await runBatch(db, [setCeilingStmt({ operation: 'slack.channel.post', enabled: true, perDayMax: 50, actorId: 'm_system', nowMs: now })])
    await db.prepare("INSERT INTO connector_accounts (account_id, connector, last_state, last_state_at_ms, connected_at_ms) VALUES ('slack:workspace', 'slack', 'connected', 1, 2000)").run()
    await channel(db, 'C0OUTBOX01', 'ops', ADMIN)
    const r = await outbox(db, clock).request(requestCtx({ nowMs: now }), { operation: 'slack.channel.post', args: { channel: '#ops', text: 'Restock is in' } }, { mode: 'tool' })
    if (r.outcome !== 'waiting') throw new Error(`expected a card, got ${r.outcome}`)
    await outbox(db, clock).answer(ASKER_ACTOR, r.action.id, { choice: 'once', ifRev: 1 })
    now += 10_000
    const d = dispatch(r.action.id)
    await d.run
    expect(d.hub.calls[0].req).toMatchObject({ operation: 'slack.channel.post', accountId: 'slack:workspace', args: { channel: 'C0OUTBOX01', text: 'Restock is in' } })
  })
})

describe('"Needs a check" (failure 6)', () => {
  const checkRow = async () => {
    await grant()
    const r = await ask(1)
    if (r.outcome !== 'approved') throw new Error('expected a run')
    now += 10_000
    const late: Promise<void>[] = []
    const hub = fakeHub(db, () => 'hang')
    await sendAction(r.action.id, { db, nowMs: now, hub: hub.gateway, notify: notices().notify, requestId: fresh('s'), again: () => {}, gate: { paused: false, pauseGen: 0 }, timeoutMs: 5, onLate: p => late.push(p) })
    return { row: (await rowOf(db, r.action.id))!, hub, late }
  }

  it('only the approver or an admin resolves it; both audited; "it didn\'t go out" releases the use', async () => {
    const { row } = await checkRow()
    expect(await outbox(db, clock).resolve({ memberId: OTHER, role: 'member' }, row.id, { outcome: 'failed', ifRev: row.rev })).toEqual({ refused: { code: 'not_found' } })
    const mark = await lastLineId(db)
    const r = await outbox(db, clock).resolve({ memberId: ADMIN, role: 'admin' }, row.id, { outcome: 'failed', ifRev: row.rev })
    expect(r).toMatchObject({ action: { state: 'failed', resolved_by: ADMIN } })
    expect(await unreleasedUses(db, row.id)).toEqual([])
    expect(await parsedSince(mark)).toEqual([expect.objectContaining({ action: 'action.resolved', outcome: 'failed', released: true })])
  })

  it("a late result doesn't change a person's answer, but settles an open check", async () => {
    const a = await checkRow()
    await outbox(db, clock).resolve(ASKER_ACTOR, a.row.id, { outcome: 'failed', ifRev: a.row.rev })
    a.hub.release({ ok: true, value: { ref: 'late' } })
    await Promise.all(a.late)
    expect(await rowOf(db, a.row.id)).toMatchObject({ state: 'failed' })

    now += 1_000
    await world(db)
    const b = await checkRow()
    b.hub.release({ ok: true, value: { ref: 'late' } })
    await Promise.all(b.late)
    expect(await rowOf(db, b.row.id)).toMatchObject({ state: 'sent' })
  })
})

describe('the sweep (failure 7)', () => {
  const sweep = (state = { paused: false, pauseGen: 0 }) => {
    const ensured: string[] = []
    const note = notices()
    return { run: sweepOutbox({ db, nowMs: now, state, scheduler: { ensure: t => ensured.push(t.id) }, notify: note.notify, requestId: fresh('sw') }), ensured, note }
  }

  it("schedules a lost approved row's send once its hold is 30 s past, and sends it once", async () => {
    const a = await approved()
    now += 10_000 + 29_000
    const early = sweep()
    await early.run
    expect(early.ensured).toEqual([])
    now += 2_000
    const late = sweep()
    await late.run
    expect(late.ensured).toEqual([`outbox-send:${a.id}`])
    const d1 = dispatch(a.id)
    const d2 = dispatch(a.id)
    await Promise.all([d1.run, d2.run])
    expect(d1.hub.calls.length + d2.hub.calls.length).toBe(1)
  })

  it('a sending row past 60 s becomes a check, never approved again; an expired card expires', async () => {
    const a = await approved()
    now += 10_000
    await runBatch(db, [claimStmt({ actionId: a.id, nowMs: now, pauseGen: 0, stamp: fresh('crash') })])
    const stale = await waitingId(2)
    now += 59_000
    await sweep().run
    expect(await rowOf(db, a.id)).toMatchObject({ state: 'sending' })
    now += 2_000
    const s = sweep()
    await s.run
    expect(await rowOf(db, a.id)).toMatchObject({ state: 'needs_check' })
    expect(s.note.list).toEqual([expect.objectContaining({ kind: 'needs_check', actionId: a.id })])
    now = stale.expires_at_ms
    await sweep().run
    expect(await rowOf(db, stale.id)).toMatchObject({ state: 'expired', lapsed_reason: 'expired' })
    expect((await rowOf(db, stale.id))!.final_at_ms).toBe(now)
  })

  it('repairs a gate out of step: the approvals lapse, the gate takes the object\'s state', async () => {
    const a = await approved()
    const s = sweep({ paused: false, pauseGen: 2 })
    expect(await s.run).toMatchObject({ synced: true })
    expect(await rowOf(db, a.id)).toMatchObject({ state: 'waiting', lapsed_reason: 'paused' })
    expect(await db.prepare('SELECT paused, do_gen, epoch FROM outbox_gate').first()).toEqual({ paused: 0, do_gen: 2, epoch: 2 })
    expect(await sweep({ paused: false, pauseGen: 2 }).run).toMatchObject({ synced: false })
  })
})

describe('the audit lines (failure 8)', () => {
  it('hold ids, codes and counts only, never an argument, each on its action', async () => {
    const mark = await lastLineId(db)
    const a = await approved(1)
    now += 10_000
    await dispatch(a.id).run
    const lines = await parsedSince(mark)
    expect(lines.map(l => l.action)).toEqual(['action.requested', 'action.answered', 'action.sent'])
    for (const l of lines) expect(l.target).toEqual(['action', a.id])
    expect(JSON.stringify(lines)).not.toContain('vip')
    expect(JSON.stringify(lines)).not.toContain('Order/1')
  })
})

describe('the routes (120 to 124)', () => {
  const stores = openStores(env)
  const pokes: unknown[] = []
  const withEnv = <C extends object>(c: C) => ({ ...c, env: { BRAND_AGENT: { getByName: () => ({ poke: async (p: unknown) => { pokes.push(p) } }) } } as never })

  it('list, read and answer a card; an approval asks for its send at the hold\'s end', async () => {
    pokes.length = 0
    const a = await waitingId()
    const list = await listActions(withEnv(handlerCtx(stores, personPrincipal(ASKER, 'member'), { path: '/api/actions?states=waiting', nowMs: now }).c))
    expect(list.status).toBe(200)
    const body = await list.json() as { items: { id: string; chatId: string | null; can: Record<string, boolean> }[] }
    expect(body.items).toEqual([expect.objectContaining({ id: a.id, chatId: 'c_ob_chat', can: expect.objectContaining({ allowOnce: true, alwaysAllow: true }) })])
    // An admin sees the card's facts without the chat, and can't answer it.
    const admin = await getAction(withEnv(handlerCtx(stores, personPrincipal(ADMIN, 'admin'), { path: `/api/actions/${a.id}`, params: { id: a.id }, nowMs: now }).c))
    expect(await admin.json()).toMatchObject({ id: a.id, chatId: null, can: { allowOnce: false, deny: false } })
    const other = await getAction(withEnv(handlerCtx(stores, personPrincipal(OTHER, 'member'), { path: `/api/actions/${a.id}`, params: { id: a.id }, nowMs: now }).c))
    expect(other.status).toBe(404)
    const answered = await answerAction(withEnv(handlerCtx(stores, personPrincipal(ASKER, 'member'), { method: 'POST', path: `/api/actions/${a.id}/answer`, params: { id: a.id }, body: { choice: 'once', ifRev: 1 }, nowMs: now }).c))
    expect(answered.status).toBe(200)
    expect(await answered.json()).toMatchObject({ state: 'approved', sendAt: { ms: now + 10_000 }, can: { undo: true } })
    expect(pokes).toEqual([{ kind: 'outbox-send', id: `outbox-send:${a.id}`, dueAtMs: now + 10_000 }])
    const stale = await answerAction(withEnv(handlerCtx(stores, personPrincipal(ASKER, 'member'), { method: 'POST', path: `/api/actions/${a.id}/answer`, params: { id: a.id }, body: { choice: 'once', ifRev: 1 }, nowMs: now }).c))
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ error: { code: 'conflict', current: { id: a.id, state: 'approved' } } })
    const undone = await undoAction(withEnv(handlerCtx(stores, personPrincipal(ASKER, 'member'), { method: 'POST', path: `/api/actions/${a.id}/undo`, params: { id: a.id }, body: { ifRev: 2 }, nowMs: now }).c))
    expect(await undone.json()).toMatchObject({ state: 'undone' })
    const resolve = await resolveAction(withEnv(handlerCtx(stores, personPrincipal(ADMIN, 'admin'), { method: 'POST', path: `/api/actions/${a.id}/resolve`, params: { id: a.id }, body: { outcome: 'sent', ifRev: 3 }, nowMs: now }).c))
    expect(resolve.status).toBe(409)
  })
})

/** Keeps the row type in view for the helpers above. */
export type { OutboxActionRow }
