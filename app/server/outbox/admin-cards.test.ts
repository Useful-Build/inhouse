// Admins cards on real D1 (Stage 1 M3-X, N25): a member asks for an operation their role can't approve, and any active
// admin answers it. The operation is tag_add with made-up flags (admins only, `customer`, never collecting), swapped into
// the table for each case (as batch.test.ts does), so this runs whichever real operation is admin-only. Ways it can fail,
// written down first:
//  1. the member's call is refused, run, asked of the member, collected into a batch, or made a card someone particular
//     answers; the 6th waiting one isn't refused `too_many_waiting`;
//  2. its asker (or another member) answers, undoes or resolves it; an admin can't; two admins answering at once both win;
//     the answer's audit line doesn't say who could answer it;
//  3. an admin demoted or removed during the hold, or never an admin, still sends; after the lapse no admin can approve
//     it again; an admin other than the approving one undoes it;
//  4. an admin's card view names the chat; the asker's card doesn't say whom it waits for, or offers buttons it can't use;
//     the asker can't take it back, or someone else can;
//  5. its notices go to `role:admin` (no one) instead of the approving admin, or every admin when none stands; a new
//     card doesn't ring every admin's bell, or rings it with the chat's words;
//  6. an admin's own call is an admins card (it's an exact card to themselves).
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuditArgsSchema } from '../../shared/contract/audit.ts'
import { getAction, withdrawAction } from '../api/actions.ts'
import { openStores } from '../db/stores.ts'
import { lastLineId, linesSince, personPrincipal, ctx as handlerCtx } from '../db/test-support.ts'
import { alertApprovalWaiting } from '../notify-slack/alerts-notices.ts'
import { person } from '../permissions/test-support.ts'
import { ADMINS_APPROVER, cardOf } from './card.ts'
import { sendAction } from './dispatch.ts'
import { noticeTargets } from './notify.ts'
import { OPERATIONS } from './operations/index.ts'
import type { OperationEntry } from './operations/types.ts'
import { ADMIN, ASKER, OTHER, fakeHub, fresh, notices, outbox, requestCtx, rowOf, tagArgs, world } from './test-support.ts'
import type { HubMode } from './test-support.ts'
import type { OutboxActionRow } from './types.ts'

const db = env.DB
const T0 = 1_800_000_000_000
let now = T0
const clock = () => now
const HOLD = 10_000
const ADMIN_2 = 'm_ob_admin_2'
const MEMBER = { memberId: ASKER, role: 'member' as const }
const ADMIN_A = { memberId: ADMIN, role: 'admin' as const }
const ADMIN_B = { memberId: ADMIN_2, role: 'admin' as const }

const table = OPERATIONS as unknown as Record<string, OperationEntry>
const real = table['shopify.order.tag_add']!

beforeEach(async () => {
  now = T0
  await world(db)
  await person(db, ADMIN_2, 'admin')
  table['shopify.order.tag_add'] = { ...real, memberMay: false, coalesces: false, effects: { ...real.effects, customer: true } } as OperationEntry
})
afterEach(() => {
  table['shopify.order.tag_add'] = real
})

const ask = (order = 1, asker: { memberId: string; role: 'member' | 'admin' } = MEMBER) =>
  outbox(db, clock).request(requestCtx({ nowMs: now, asker }), { operation: 'shopify.order.tag_add', args: tagArgs(order) }, { mode: 'tool' })
const card = async (order = 1): Promise<OutboxActionRow> => {
  const r = await ask(order)
  if (r.outcome !== 'waiting') throw new Error(`expected a card, got ${r.outcome}`)
  return r.action
}
const approveBy = async (actor: typeof ADMIN_A, row: OutboxActionRow) => {
  const r = await outbox(db, clock).answer(actor, row.id, { choice: 'approve', ifRev: row.rev })
  if (!('action' in r)) throw new Error(`answer refused: ${r.refused.code}`)
  return r.action
}
const send = async (id: string, mode: HubMode = 'ok') => {
  const hub = fakeHub(db, () => mode)
  const note = notices()
  await sendAction(id, { db, nowMs: now, hub: hub.gateway, notify: note.notify, requestId: fresh('send'), again: () => {}, gate: { paused: false, pauseGen: 0 }, timeoutMs: 5 })
  return { hub, note }
}
const parsedSince = async (mark: number) =>
  (await linesSince(db, mark)).map(l => AuditArgsSchema.parse({ action: l.action, ...(JSON.parse(l.args_json) as object) }))

describe('the request (failure 1, 6)', () => {
  it("a member's call their role can't approve is one exact card for any active admin", async () => {
    const r = await ask()
    expect(r).toMatchObject({
      outcome: 'waiting',
      action: { kind: 'single', verdict: 'exact', guardrail: 'customer', approver_kind: 'admins', approver: ADMINS_APPROVER, asked_by: ASKER, grant_id: null },
    })
  })

  it("an admin's own call is an exact card to themselves, never an admins card", async () => {
    const r = await ask(1, ADMIN_A)
    expect(r).toMatchObject({ outcome: 'waiting', action: { verdict: 'exact', guardrail: 'customer', approver_kind: 'person', approver: ADMIN } })
  })

  it('never collects: the 6th waiting admins card in a chat is refused `too_many_waiting`', async () => {
    for (let k = 1; k <= 5; k++) expect((await ask(k)).outcome).toBe('waiting')
    expect(await ask(6)).toMatchObject({ outcome: 'refused', reason: 'too_many_waiting' })
    expect((await db.prepare("SELECT COUNT(*) AS n FROM outbox_actions WHERE kind = 'batch'").first<{ n: number }>())?.n).toBe(0)
  })
})

describe('answers (failure 2)', () => {
  it("its member asker, or another member, can't answer it; a No or an Approve from an admin can", async () => {
    const a = await card()
    expect(await outbox(db, clock).answer(MEMBER, a.id, { choice: 'approve', ifRev: a.rev })).toEqual({ refused: { code: 'forbidden', reason: 'not_owner' } })
    expect(await outbox(db, clock).answer(MEMBER, a.id, { choice: 'deny', ifRev: a.rev })).toEqual({ refused: { code: 'forbidden', reason: 'not_owner' } })
    expect(await outbox(db, clock).answer({ memberId: OTHER, role: 'member' }, a.id, { choice: 'approve', ifRev: a.rev })).toEqual({ refused: { code: 'not_found' } })
    // A member presenting an admin's role (a stale session) is refused by the statement itself.
    expect(await outbox(db, clock).answer({ memberId: ASKER, role: 'admin' }, a.id, { choice: 'approve', ifRev: a.rev })).toEqual({ refused: { code: 'forbidden' } })
    expect(await rowOf(db, a.id)).toMatchObject({ state: 'waiting', approved_by: null })
    const b = await card(2)
    expect(await outbox(db, clock).answer(ADMIN_A, b.id, { choice: 'deny', ifRev: b.rev })).toMatchObject({ action: { state: 'denied' } })
    expect(await approveBy(ADMIN_A, a)).toMatchObject({ state: 'approved', approved_by: ADMIN, approver: ADMINS_APPROVER })
  })

  it('two admins answering at once give one approval, and the line says any admin could answer', async () => {
    const a = await card()
    const mark = await lastLineId(db)
    const [x, y] = await Promise.all([
      outbox(db, clock).answer(ADMIN_A, a.id, { choice: 'approve', ifRev: a.rev }),
      outbox(db, clock).answer(ADMIN_B, a.id, { choice: 'approve', ifRev: a.rev }),
    ])
    const won = [x, y].filter(r => 'action' in r)
    expect(won).toHaveLength(1)
    expect([x, y].filter(r => 'refused' in r)).toEqual([{ refused: { code: 'conflict' } }])
    const winner = (won[0] as { action: OutboxActionRow }).action.approved_by
    expect([ADMIN, ADMIN_2]).toContain(winner)
    expect(await rowOf(db, a.id)).toMatchObject({ state: 'approved', rev: 2, approved_by: winner })
    expect(await parsedSince(mark)).toEqual([{ action: 'action.answered', actionId: a.id, choice: 'approve', approverKind: 'admins' }])
  })

  it('an approve and a No from two admins at once: one wins', async () => {
    const a = await card()
    const results = await Promise.all([
      outbox(db, clock).answer(ADMIN_A, a.id, { choice: 'approve', ifRev: a.rev }),
      outbox(db, clock).answer(ADMIN_B, a.id, { choice: 'deny', ifRev: a.rev }),
    ])
    expect(results.filter(r => 'action' in r)).toHaveLength(1)
    expect(['approved', 'denied']).toContain((await rowOf(db, a.id))!.state)
  })
})

describe('the hold and the claim (failure 3)', () => {
  it('sends once the hold ends, approved by an active admin', async () => {
    const a = await approveBy(ADMIN_A, await card())
    now += HOLD
    const { hub } = await send(a.id)
    expect(hub.calls).toHaveLength(1)
    expect(hub.calls[0]!.violation).toBeNull()
    expect(await rowOf(db, a.id)).toMatchObject({ state: 'sent' })
  })

  for (const [what, change] of [
    ['demoted', () => person(db, ADMIN, 'member')],
    ['removed', () => person(db, ADMIN, 'admin', 'removed')],
  ] as const) {
    it(`an admin ${what} during the hold stops the claim: no call, back to waiting for any admin, every admin told`, async () => {
      const a = await approveBy(ADMIN_A, await card())
      await change()
      now += HOLD
      const { hub, note } = await send(a.id)
      expect(hub.calls).toEqual([])
      const after = await rowOf(db, a.id)
      expect(after).toMatchObject({ state: 'waiting', lapsed_reason: 'approver_not_allowed', approved_by: null, approver: ADMINS_APPROVER })
      expect(note.list).toEqual([expect.objectContaining({ kind: 'approval_lapsed', to: ADMINS_APPROVER, actionId: a.id })])
      // No admin's approval stands any more, so the notice reaches every active admin (the demoted one isn't one).
      expect(await noticeTargets(db, ADMINS_APPROVER, a.id)).toEqual([ADMIN_2])
      // The demoted one can't approve it again; another admin can, and it goes out.
      expect(await outbox(db, clock).answer({ memberId: ADMIN, role: 'admin' }, a.id, { choice: 'approve', ifRev: after!.rev })).toMatchObject({ refused: { code: 'forbidden' } })
      const again = await approveBy(ADMIN_B, after!)
      now += HOLD
      expect((await send(again.id)).hub.calls).toHaveLength(1)
      expect(await rowOf(db, a.id)).toMatchObject({ state: 'sent', approved_by: ADMIN_2 })
    })
  }

  it('an approval set by hand to a member never sends (the claim checks the approver is an admin)', async () => {
    const a = await approveBy(ADMIN_A, await card())
    await db.prepare('UPDATE outbox_actions SET approved_by = ? WHERE id = ?').bind(ASKER, a.id).run()
    now += HOLD
    const { hub } = await send(a.id)
    expect(hub.calls).toEqual([])
    expect(await rowOf(db, a.id)).toMatchObject({ state: 'waiting', lapsed_reason: 'approver_not_allowed' })
  })

  it('only the approving admin undoes it in the hold; its asker and other admins can\'t', async () => {
    const a = await approveBy(ADMIN_A, await card())
    expect(await outbox(db, clock).undo(MEMBER, a.id, { ifRev: a.rev })).toEqual({ refused: { code: 'forbidden', reason: 'not_owner' } })
    expect(await outbox(db, clock).undo(ADMIN_B, a.id, { ifRev: a.rev })).toEqual({ refused: { code: 'forbidden', reason: 'not_owner' } })
    expect(await outbox(db, clock).undo(ADMIN_A, a.id, { ifRev: a.rev })).toMatchObject({ action: { state: 'undone' } })
  })

  it('a needs-check is told to the approving admin, and any admin resolves it, never its asker', async () => {
    const a = await approveBy(ADMIN_A, await card())
    now += HOLD
    const { note } = await send(a.id, 'unknown')
    const row = (await rowOf(db, a.id))!
    expect(row).toMatchObject({ state: 'needs_check', approved_by: ADMIN })
    expect(note.list).toEqual([expect.objectContaining({ kind: 'needs_check', to: ADMINS_APPROVER })])
    expect(await noticeTargets(db, ADMINS_APPROVER, a.id)).toEqual([ADMIN])
    expect(await outbox(db, clock).resolve(MEMBER, a.id, { outcome: 'sent', ifRev: row.rev })).toEqual({ refused: { code: 'forbidden', reason: 'not_owner' } })
    expect(await outbox(db, clock).resolve(ADMIN_B, a.id, { outcome: 'sent', ifRev: row.rev })).toMatchObject({ action: { state: 'sent', resolved_by: ADMIN_2 } })
  })
})

describe('the cards and the withdraw (failure 4)', () => {
  const stores = openStores(env)
  const withEnv = <C extends object>(c: C) => ({ ...c, env: { BRAND_AGENT: { getByName: () => ({ poke: async () => {}, actionChanged: async () => {} }) } } as never })

  it('the asker sees it in their chat waiting for an admin; admins see its facts, never the chat', async () => {
    const a = await card()
    const mine = cardOf(a, MEMBER, now)
    expect(mine).toMatchObject({
      approverKind: 'admins', waitingFor: 'an admin', chatId: 'c_ob_chat', kind: 'exact',
      can: { allowOnce: false, alwaysAllow: false, approve: false, deny: false, undo: false, resolve: false, withdraw: true },
    })
    const theirs = cardOf(a, ADMIN_A, now)
    expect(theirs).toMatchObject({ approverKind: 'admins', chatId: null, can: { approve: true, deny: true, withdraw: false } })
    expect(theirs.waitingFor).toBeUndefined()
    // Through the route: the admin's read never names the chat; another member can't see it.
    const read = await getAction(withEnv(handlerCtx(stores, personPrincipal(ADMIN_2, 'admin'), { path: `/api/actions/${a.id}`, params: { id: a.id }, nowMs: now }).c))
    expect(await read.json()).toMatchObject({ id: a.id, chatId: null, can: { approve: true } })
    const other = await getAction(withEnv(handlerCtx(stores, personPrincipal(OTHER, 'member'), { path: `/api/actions/${a.id}`, params: { id: a.id }, nowMs: now }).c))
    expect(other.status).toBe(404)
    // Approved: only the approving admin's card offers Undo.
    const done = await approveBy(ADMIN_A, a)
    expect(cardOf(done, ADMIN_A, now).can.undo).toBe(true)
    expect(cardOf(done, ADMIN_B, now).can.undo).toBe(false)
    expect(cardOf(done, MEMBER, now)).toMatchObject({ can: { undo: false, withdraw: false } })
    expect(cardOf(done, MEMBER, now).waitingFor).toBeUndefined()
  })

  it('its asker takes it back through route 126; an admin or another member can\'t; a stale revision is 409', async () => {
    const a = await card()
    const post = (who: string, role: 'member' | 'admin', ifRev: number) =>
      withdrawAction(withEnv(handlerCtx(stores, personPrincipal(who, role), { method: 'POST', path: `/api/actions/${a.id}/withdraw`, params: { id: a.id }, body: { ifRev }, nowMs: now }).c))
    expect((await post(OTHER, 'member', a.rev)).status).toBe(404)
    expect((await post(ADMIN, 'admin', a.rev)).status).toBe(403)
    expect((await post(ASKER, 'member', a.rev + 1)).status).toBe(409)
    const mark = await lastLineId(db)
    const ok = await post(ASKER, 'member', a.rev)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ id: a.id, state: 'withdrawn', can: { withdraw: false } })
    expect(await parsedSince(mark)).toEqual([{ action: 'action.withdrawn', actionId: a.id, by: 'member' }])
    expect(await outbox(db, clock).answer(ADMIN_A, a.id, { choice: 'approve', ifRev: a.rev + 1 })).toMatchObject({ refused: { code: 'conflict' } })
  })
})

describe('notices (failure 5)', () => {
  it("a new admins card rings every active admin's bell, with the fixed title and no words of the chat", async () => {
    await person(db, 'm_ob_admin_gone', 'admin', 'removed')
    const a = await card()
    await alertApprovalWaiting({ DB: db }, a.id, { nowMs: now })
    const bells = (await db.prepare("SELECT target FROM notify_sends WHERE notice_kind = 'approval_waiting' AND kind = 'bell' AND system_key = ? ORDER BY target")
      .bind(`approval-waiting:${a.id}`).all<{ target: string }>()).results.map(r => r.target)
    expect(bells).toEqual([ADMIN, ADMIN_2].sort())
    const bells2 = (await db.prepare("SELECT audience_member_id AS m, body FROM notices WHERE id IN (SELECT id FROM notify_sends WHERE system_key = ?) ORDER BY m")
      .bind(`approval-waiting:${a.id}`).all<{ m: string; body: string | null }>()).results
    expect(bells2).toEqual([{ m: ADMIN, body: null }, { m: ADMIN_2, body: null }].sort((x, y) => (x.m < y.m ? -1 : 1)))
    // A person's own card rings no bell (it's in their chat).
    const own = await ask(9, ADMIN_A)
    if (own.outcome !== 'waiting') throw new Error('expected a card')
    await alertApprovalWaiting({ DB: db }, own.action.id, { nowMs: now })
    expect((await db.prepare("SELECT COUNT(*) AS n FROM notify_sends WHERE kind = 'bell' AND system_key = ?").bind(`approval-waiting:${own.action.id}`).first<{ n: number }>())?.n).toBe(0)
  })

  it("a person's card's notices go to its approver, unchanged", async () => {
    const own = await ask(9, ADMIN_A)
    if (own.outcome !== 'waiting') throw new Error('expected a card')
    expect(await noticeTargets(db, own.action.approver, own.action.id)).toEqual([ADMIN])
  })
})
