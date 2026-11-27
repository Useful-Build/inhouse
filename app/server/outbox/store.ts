// The outbox's port (N11, N15): `request` is the only way a write gets in; every other change to a row is a person's
// (answer, Undo, withdraw, resolve) or the dispatcher's (dispatch.ts, sweep.ts). Each write is one D1 batch: one
// conditional update (or insert) that decides, then statements and audit lines that act only where its stamp is. The
// rules on who may act sit in that update's WHERE, never only in a read before it.
import type { ActionFilter } from '../../shared/contract/actions.ts'
import type { AuditHook } from '../db/audit.ts'
import { writeStamp } from '../db/ids.ts'
import { all, first, runBatch, stmt } from '../db/sql.ts'
import type { SqlValue, Stmt } from '../db/sql.ts'
import { decideCore, memberHolder } from '../permissions/decide.ts'
import { alwaysAllowStmts } from '../permissions/grants.ts'
import { NUDGE_AFTER } from '../permissions/policy.ts'
import { resolve } from '../permissions/resolve.ts'
import type { DecideCtx, Resolved, Verdict } from '../permissions/types.ts'
import { reserveUseSql, useDay as dayOfUse } from '../permissions/uses.ts'
import { kindOf } from './card.ts'
import type { StoredCard, Viewer } from './card.ts'
import { brandTimeZone } from './facts.ts'
import type { OutboxFacts } from './facts.ts'
import { grantDefaults, operationEntry } from './operations/index.ts'
import {
  actionLine, both, butNot, GATE_OPEN, newActionId, permissionUseKey, releaseUseWhere, reserveUseByKeyWhere, stamped, unreleasedUse,
} from './sql.ts'
import type { Exists } from './sql.ts'
import { timing } from './timing.ts'
import type {
  OutboxActionRow, OutboxActor, OutboxChange, OutboxPort, OutboxRefusal, OutboxRefuseReason, OutboxRequestCtx, OutboxRequestResult,
} from './types.ts'
import { REFUSAL_TEXT } from './words.ts'

export interface OutboxDeps {
  db: D1Database
  /** This request's id: every write stamps with it and its audit lines carry it. */
  requestId: string
  now: () => number
  /** `request`'s reads (accounts, channels, ceiling, grants). Only `request` needs them. */
  facts?: OutboxFacts
  /**
   * Asks BrandAgent to run `outbox-send:<id>` at `atMs` (its `poke`). A failure is logged, not thrown: the approval
   * stands, and the sweep finds an approved row whose task was lost within `lostTaskMs` of its hold.
   */
  schedule: (actionId: string, atMs: number) => Promise<void>
  /** Tests only: swaps an audit statement (an invalid one proves the change rolls back with it). */
  hook?: AuditHook
}

const refusedRequest = (reason: OutboxRefuseReason): OutboxRequestResult => ({ outcome: 'refused', reason, text: REFUSAL_TEXT[reason] })
const refusal = (code: OutboxRefusal['refused']['code'], reason?: OutboxRefusal['refused']['reason']): OutboxRefusal =>
  ({ refused: { code, ...(reason ? { reason } : {}) } })

/** A row a person may see: their own (asked or to approve), or any for an admin (N15). */
export const mayView = (row: Pick<OutboxActionRow, 'asked_by' | 'approver'>, v: Viewer): boolean =>
  v.role === 'admin' || row.asked_by === v.memberId || row.approver === v.memberId

/** An active brand person whose role may do this operation (the answer's and the claim's check). */
const mayDo = (memberParam: string, memberMay: boolean) =>
  `EXISTS (SELECT 1 FROM members m WHERE m.id = ${memberParam} AND m.kind = 'person' AND m.status = 'active' AND (m.role = 'admin' OR ${memberMay ? 1 : 0} = 1))`

/** The row's chat isn't in the trash (M2-D, N11): an answer never approves a card of a deleted chat. */
const CHAT_NOT_DELETED = 'NOT EXISTS (SELECT 1 FROM chats c WHERE c.id = outbox_actions.chat_id AND c.deleted_at_ms IS NOT NULL)'

const INSERT_COLUMNS = [
  'id', 'rev', 'state', 'verdict', 'guardrail', 'origin', 'via', 'asked_by', 'approver', 'chat_id', 'run_id', 'turn_id', 'tool_use_id', 'job_id',
  'account_id', 'account_gen', 'operation', 'policy_rev', 'scope_json', 'scope_key', 'args_json', 'payload_hash', 'records', 'units', 'card_json',
  'grant_id', 'approved_by', 'approved_rev', 'approved_at_ms', 'send_at_ms', 'expires_at_ms', 'created_at_ms', 'updated_at_ms', 'stamp',
] as const

interface NewRow {
  id: string
  state: 'waiting' | 'approved'
  verdict: 'run' | 'ask' | 'exact'
  guardrail: string | null
  ctx: OutboxRequestCtx
  via: 'tool' | 'approval_request'
  r: Resolved
  card: StoredCard
  grantId: string | null
  nowMs: number
  stamp: string
}

/**
 * The action's insert: never a second waiting card for the same payload in this chat, never a second row for the same
 * invocation (the unique index, `ON CONFLICT DO NOTHING`), and only where `also` holds. An approved row takes the
 * gate's epoch in the same statement.
 */
function insertAction(n: NewRow, also: readonly Exists[]): Stmt {
  const asker = n.ctx.asker
  if (!asker) throw new Error('outbox: an action with no asker')
  const t = timing()
  const approved = n.state === 'approved'
  const values: SqlValue[] = [
    n.id, 1, n.state, n.verdict, n.guardrail, n.ctx.origin, n.via, asker.memberId, asker.memberId, n.ctx.chatId,
    n.ctx.invocation?.runId ?? null, n.ctx.invocation?.turnId ?? null, n.ctx.invocation?.toolUseId ?? null, n.ctx.jobId,
    n.r.accountId, n.r.accountGen, n.r.operation, n.r.policyRev, JSON.stringify(n.r.scope), n.r.scopeKey, JSON.stringify(n.r.args), n.r.payloadHash,
    n.r.records, n.r.units, JSON.stringify(n.card),
    n.grantId, approved ? `grant:${n.grantId}` : null, approved ? 1 : null, approved ? n.nowMs : null, approved ? n.nowMs + t.holdMs : null,
    n.nowMs + t.expiresMs, n.nowMs, n.nowMs, n.stamp,
  ]
  const conds = [
    `NOT EXISTS (SELECT 1 FROM outbox_actions WHERE chat_id = ? AND payload_hash = ? AND state = 'waiting' AND expires_at_ms > ?)`,
    // M2-D (N11): never into a chat in the trash, decided in the insert itself (a deletion may land after any read).
    'NOT EXISTS (SELECT 1 FROM chats WHERE id = ? AND deleted_at_ms IS NOT NULL)',
    ...also.map(e => `EXISTS (${e.sql})`),
  ]
  return stmt(
    `INSERT INTO outbox_actions (${INSERT_COLUMNS.join(', ')}, approved_epoch)
     SELECT ${INSERT_COLUMNS.map(() => '?').join(', ')}, ${approved ? '(SELECT epoch FROM outbox_gate WHERE id = 1)' : 'NULL'}
     WHERE ${conds.join(' AND ')}
     ON CONFLICT DO NOTHING`,
    ...values, n.ctx.chatId, n.r.payloadHash, n.nowMs, n.ctx.chatId, ...also.flatMap(e => e.params),
  )
}

export function openOutbox(d: OutboxDeps): OutboxPort & {
  get(viewer: Viewer, id: string): Promise<OutboxActionRow | null>
  list(viewer: Viewer, filter: ActionFilter): Promise<OutboxActionRow[]>
} {
  const { db } = d
  const hook = d.hook ?? (s => s)
  const row = (id: string) => first<OutboxActionRow>(db, stmt('SELECT * FROM outbox_actions WHERE id = ?', id))
  const byInvocation = (chatId: string, toolUseId: string) =>
    first<OutboxActionRow>(db, stmt('SELECT * FROM outbox_actions WHERE chat_id = ? AND tool_use_id = ?', chatId, toolUseId))
  const waitingDup = (chatId: string, payloadHash: string) =>
    first<OutboxActionRow>(db, stmt(
      "SELECT * FROM outbox_actions WHERE chat_id = ? AND payload_hash = ? AND state = 'waiting' AND expires_at_ms > ? ORDER BY created_at_ms LIMIT 1",
      chatId, payloadHash, d.now(),
    ))
  const chatDeleted = async (chatId: string) =>
    (await first<{ one: number }>(db, stmt('SELECT 1 AS one FROM chats WHERE id = ? AND deleted_at_ms IS NOT NULL', chatId))) !== null
  const gateOpen = async () => (await first<{ one: number }>(db, stmt(`${GATE_OPEN.replace('SELECT 1', 'SELECT 1 AS one')}`))) !== null
  const scheduleSend = async (actionId: string, atMs: number) => {
    try {
      await d.schedule(actionId, atMs)
    } catch (err) {
      console.error({ event: 'outbox_schedule_failed', actionId, requestId: d.requestId, error: err instanceof Error ? err.name : 'unknown' })
    }
  }
  const at = (actorId: string, nowMs: number) => ({ atMs: nowMs, actorId, requestId: d.requestId })

  /** `decideCore` on fresh facts; `ask_only` never runs (`approval_request`). */
  async function decide(facts: OutboxFacts, ctx: OutboxRequestCtx, r: Resolved, mode: 'tool' | 'ask_only'): Promise<Verdict> {
    const f = await facts.decideFacts(r, ctx satisfies DecideCtx)
    const v = decideCore(f, ctx, r)
    if (mode === 'ask_only' && v.verdict === 'run') return { verdict: 'ask', nudge: f.allowOnceCount >= NUDGE_AFTER }
    return v
  }

  /** After an insert that didn't apply: the same invocation's row, or the waiting card for the same payload. */
  async function existingFor(ctx: OutboxRequestCtx, r: Resolved): Promise<OutboxRequestResult | null> {
    if (ctx.invocation) {
      const prior = await byInvocation(ctx.chatId, ctx.invocation.toolUseId)
      if (prior) return prior.payload_hash === r.payloadHash ? { outcome: 'existing', action: prior } : refusedRequest('invocation_conflict')
    }
    const dup = await waitingDup(ctx.chatId, r.payloadHash)
    return dup ? { outcome: 'waiting', action: dup, existing: true } : null
  }

  return {
    async request(ctx, proposed, { mode }) {
      const facts = d.facts
      if (!facts) throw new Error('outbox: request needs the facts reader')
      const nowMs = d.now()
      const rf = await facts.resolveFacts(nowMs)
      const r = await resolve(rf, proposed)
      if ('refuse' in r) return refusedRequest(r.refuse.reason)
      // A replay of the same invocation is answered from its row, whatever the rules say now.
      if (ctx.invocation) {
        const prior = await byInvocation(ctx.chatId, ctx.invocation.toolUseId)
        if (prior) return prior.payload_hash === r.payloadHash ? { outcome: 'existing', action: prior } : refusedRequest('invocation_conflict')
      }
      // M2-D (N11): nothing new from a deleted chat (its deletion withdraws what it had; this covers a request that lands
      // between the deletion and BrandAgent's end of the chat's turns, or when that end fails).
      if (await chatDeleted(ctx.chatId)) return refusedRequest('chat_deleted')
      let v = await decide(facts, ctx, r, mode)
      if (v.verdict === 'refuse') return refusedRequest(v.reason)
      const dup = await waitingDup(ctx.chatId, r.payloadHash)
      if (dup) return { outcome: 'waiting', action: dup, existing: true }
      const entry = operationEntry(r.operation)
      const account = entry ? rf.accounts[entry.connector] : null
      if (!entry || !account) throw new Error('outbox: a resolved action names no operation or account')
      const words = entry.card(r.args, rf)
      const card = (nudge: boolean): StoredCard => ({ title: words.title, lines: words.lines, label: account.label, nudge })
      const asker = ctx.asker
      if (!asker) throw new Error('outbox: decide let through an action with no asker')
      const via = mode === 'ask_only' ? 'approval_request' : 'tool'

      if (v.verdict === 'run') {
        // The use first, then the action only where that use exists and the gate is open; the use goes again in the same
        // batch if the action didn't (a closed gate, a card that appeared meanwhile).
        const id = newActionId()
        const stamp = writeStamp(d.requestId)
        const tz = await brandTimeZone(db)
        const use = reserveUseSql({ actionId: id, actionRev: 1, grantId: v.grantId, day: dayOfUse(nowMs, tz), units: r.units, atMs: nowMs })
        await runBatch(db, [
          use,
          insertAction({ id, state: 'approved', verdict: 'run', guardrail: null, ctx, via, r, card: card(false), grantId: v.grantId, nowMs, stamp }, [unreleasedUse(id, 1), { sql: GATE_OPEN, params: [] }]),
          stmt('DELETE FROM permission_uses WHERE id = ? AND NOT EXISTS (SELECT 1 FROM outbox_actions WHERE id = ?)', `${id}#1`, id),
          hook(actionLine(
            { ...at(asker.memberId, nowMs), args: { action: 'action.requested', actionId: id, operation: r.operation, verdict: 'run', origin: ctx.origin, records: r.records, units: r.units, permissionId: v.grantId } },
            stamped(id, stamp),
          )),
        ])
        const made = await row(id)
        if (made) {
          // Branch on the row as it is now: a Pause's sync may have sent it back to waiting since the batch.
          if (made.state === 'approved' && made.send_at_ms !== null) {
            await scheduleSend(id, made.send_at_ms)
            return { outcome: 'approved', action: made }
          }
          return made.state === 'waiting' ? { outcome: 'waiting', action: made, existing: false } : { outcome: 'existing', action: made }
        }
        const existing = await existingFor(ctx, r)
        if (existing) return existing
        if (await chatDeleted(ctx.chatId)) return refusedRequest('chat_deleted')
        // The reservation lost (the day's units spent, the grant revoked meanwhile) or the gate closed: decide again. A
        // `run` that still can't reserve is an exact approval with guardrail `count`, never `run` and never `ask` (N10);
        // a closed gate leaves an ordinary card for after the Resume.
        v = await decide(facts, ctx, r, mode)
        if (v.verdict === 'refuse') return refusedRequest(v.reason)
        if (v.verdict === 'run') v = (await gateOpen()) ? { verdict: 'exact', guardrail: 'count', approver: 'asker' } : { verdict: 'ask', nudge: false }
      }

      const id = newActionId()
      const stamp = writeStamp(d.requestId)
      const verdict = v.verdict as 'ask' | 'exact'
      const guardrail = v.verdict === 'exact' ? v.guardrail : null
      const nudge = v.verdict === 'ask' && v.nudge
      await runBatch(db, [
        insertAction({ id, state: 'waiting', verdict, guardrail, ctx, via, r, card: card(nudge), grantId: null, nowMs, stamp }, []),
        hook(actionLine(
          { ...at(asker.memberId, nowMs), args: { action: 'action.requested', actionId: id, operation: r.operation, verdict, ...(guardrail ? { guardrail } : {}), origin: ctx.origin, records: r.records, units: r.units } },
          stamped(id, stamp),
        )),
      ])
      const made = await row(id)
      if (made) return { outcome: 'waiting', action: made, existing: false }
      const existing = await existingFor(ctx, r)
      if (existing) return existing
      if (await chatDeleted(ctx.chatId)) return refusedRequest('chat_deleted')
      throw new Error('outbox: a waiting insert applied nothing and no row explains it')
    },

    async answer(actor, actionId, input) {
      const nowMs = d.now()
      const before = await row(actionId)
      if (!before || !mayView(before, actor)) return refusal('not_found')
      if (before.approver !== actor.memberId) return refusal('forbidden', 'not_owner')
      // M2-D (N11): a card whose chat was deleted can't be answered (its deletion withdraws it; this covers the race).
      if (await chatDeleted(before.chat_id)) return refusal('conflict')
      const kind = kindOf(before)
      if ((input.choice === 'once' || input.choice === 'always') && kind !== 'ask') return refusal('invalid')
      if (input.choice === 'approve' && kind !== 'exact') return refusal('invalid')
      const entry = operationEntry(before.operation)
      if (!entry) throw new Error(`outbox: a stored action names no operation (${actionId})`)
      const stamp = writeStamp(d.requestId)
      const mine = stamped(actionId, stamp)
      const approving = input.choice !== 'deny'
      const sendAt = nowMs + timing().holdMs
      // The card's kind, in SQL: an `ask` card takes Allow once and Always allow, an exact one Approve (card.ts `kindOf`).
      const kindSql = input.choice === 'approve' ? "(verdict = 'exact' OR origin = 'routine')"
        : input.choice === 'deny' ? '1' : "(verdict <> 'exact' AND origin <> 'routine')"
      const stmts: Stmt[] = [approving
        ? stmt(
          `UPDATE outbox_actions SET state = 'approved', rev = rev + 1, approved_by = ?, approved_rev = rev + 1, approved_at_ms = ?,
             approved_epoch = (SELECT epoch FROM outbox_gate WHERE id = 1), send_at_ms = ?, grant_id = NULL, lapsed_reason = NULL,
             updated_at_ms = ?, stamp = ?
           WHERE id = ? AND rev = ? AND state = 'waiting' AND approver = ? AND expires_at_ms > ? AND ${kindSql}
             AND ${mayDo('?', entry.memberMay)} AND EXISTS (${GATE_OPEN}) AND ${CHAT_NOT_DELETED}`,
          actor.memberId, nowMs, sendAt, nowMs, stamp, actionId, input.ifRev, actor.memberId, nowMs, actor.memberId,
        )
        : stmt(
          `UPDATE outbox_actions SET state = 'denied', rev = rev + 1, final_at_ms = ?, updated_at_ms = ?, stamp = ?
           WHERE id = ? AND rev = ? AND state = 'waiting' AND approver = ?
             AND EXISTS (SELECT 1 FROM members m WHERE m.id = ? AND m.kind = 'person' AND m.status = 'active') AND ${CHAT_NOT_DELETED}`,
          nowMs, nowMs, stamp, actionId, input.ifRev, actor.memberId, actor.memberId,
        )]
      const line = (permissionId?: string) => ({
        ...at(actor.memberId, nowMs),
        args: { action: 'action.answered' as const, actionId, choice: input.choice, ...(permissionId ? { permissionId } : {}) },
      })
      if (input.choice === 'always') {
        // The grant (or the live one already there), the action's use under it and `grant_id`, all only under this
        // answer's stamp. Which grant is found in SQL by its key when the batch runs, never read before it. `grant_id`
        // is set only where the use was reserved: otherwise the person's own approval of this revision stands, and the
        // grant is there for the next one.
        const scope = JSON.parse(before.scope_json) as Record<string, string>
        const key = { holder: memberHolder(actor.memberId), accountId: before.account_id, operation: before.operation, scopeKey: before.scope_key }
        const grant = alwaysAllowStmts({
          holderMemberId: actor.memberId, grantedRole: actor.role,
          resolved: { accountId: before.account_id, accountGen: before.account_gen, operation: before.operation, scope, scopeKey: before.scope_key, policyRev: before.policy_rev },
          perDay: grantDefaults(entry.key).perDay, sourceAction: actionId, onlyIf: mine, at: { actorId: actor.memberId, requestId: d.requestId, nowMs },
        })
        const nextRev = input.ifRev + 1
        const tz = await brandTimeZone(db)
        const use = permissionUseKey(actionId, nextRev)
        stmts.push(
          ...grant.stmts.map(s => hook(s)),
          reserveUseByKeyWhere(key, { actionId, actionRev: nextRev, day: dayOfUse(nowMs, tz), units: before.units, atMs: nowMs }, mine),
          stmt(
            `UPDATE outbox_actions SET grant_id = (SELECT grant_id FROM permission_uses WHERE id = ? AND released_at_ms IS NULL)
             WHERE id = ? AND stamp = ? AND EXISTS (SELECT 1 FROM permission_uses WHERE id = ? AND released_at_ms IS NULL)`,
            use, actionId, stamp, use,
          ),
          // The line names the grant the batch found, so it's built in SQL from the row (ids and a closed code only).
          stmt(
            `INSERT INTO audit_log (at_ms, actor_id, action, target_kind, target_id, args_json, req_id)
             SELECT ?, ?, 'action.answered', 'action', a.id, json_object('actionId', a.id, 'choice', 'always', 'permissionId', a.grant_id), ?
             FROM outbox_actions a WHERE a.id = ? AND a.stamp = ? AND a.grant_id IS NOT NULL`,
            nowMs, actor.memberId, d.requestId, actionId, stamp,
          ),
          hook(actionLine(line(), { sql: `${mine.sql} AND grant_id IS NULL`, params: mine.params })),
        )
      } else {
        stmts.push(hook(actionLine(line(), mine)))
      }
      await runBatch(db, stmts)
      const after = await row(actionId)
      if (after && after.stamp === stamp) {
        if (after.state === 'approved') await scheduleSend(actionId, after.send_at_ms as number)
        return { action: after }
      }
      if (!after || after.rev !== input.ifRev || after.state !== 'waiting') return refusal('conflict')
      if (after.expires_at_ms <= nowMs) return refusal('conflict')
      if (await chatDeleted(after.chat_id)) return refusal('conflict')
      if (approving && !(await gateOpen())) return refusal('conflict', 'paused')
      return refusal('forbidden')
    },

    async undo(actor, actionId, input) {
      const nowMs = d.now()
      const before = await row(actionId)
      if (!before || !mayView(before, actor)) return refusal('not_found')
      if (before.approver !== actor.memberId) return refusal('forbidden', 'not_owner')
      const stamp = writeStamp(d.requestId)
      const mine = stamped(actionId, stamp)
      const line = (released: boolean) => ({ ...at(actor.memberId, nowMs), args: { action: 'action.undone' as const, actionId, released } })
      await runBatch(db, [
        stmt(
          `UPDATE outbox_actions SET state = 'undone', rev = rev + 1, final_at_ms = ?, updated_at_ms = ?, stamp = ?
           WHERE id = ? AND rev = ? AND state = 'approved' AND approver = ?`,
          nowMs, nowMs, stamp, actionId, input.ifRev, actor.memberId,
        ),
        hook(actionLine(line(true), both(mine, unreleasedUse(actionId, input.ifRev)))),
        hook(actionLine(line(false), butNot(mine, unreleasedUse(actionId, input.ifRev)))),
        releaseUseWhere({ actionId, actionRev: input.ifRev, reason: 'undone', atMs: nowMs }, mine),
      ])
      const after = await row(actionId)
      if (after && after.stamp === stamp) return { action: after }
      return refusal('conflict')
    },

    async withdraw(by, actionId, input) {
      const nowMs = d.now()
      const before = await row(actionId)
      if (!before) return refusal('not_found')
      if (by.kind === 'member') {
        if (!mayView(before, by.actor)) return refusal('not_found')
        if (before.asked_by !== by.actor.memberId) return refusal('forbidden', 'not_owner')
      } else if (before.chat_id !== by.chatId) {
        return refusal('not_found')
      }
      const stamp = writeStamp(d.requestId)
      const actorId = by.kind === 'member' ? by.actor.memberId : before.asked_by
      const who = by.kind === 'member' ? stmt('asked_by = ?', by.actor.memberId) : stmt('chat_id = ?', by.chatId)
      // Stage 1 M2-G: the agent's own withdraw (approval_withdraw) told the agent in its answer, so nobody needs a resume
      // turn about it (`report = 'none'`). A person's withdraw leaves `report` for the asks' delivery to decide.
      const report = by.kind === 'agent' ? ", report = 'none'" : ''
      await runBatch(db, [
        stmt(
          `UPDATE outbox_actions SET state = 'withdrawn', rev = rev + 1, final_at_ms = ?, updated_at_ms = ?, stamp = ?${report}
           WHERE id = ? AND rev = ? AND state = 'waiting' AND ${who.sql}`,
          nowMs, nowMs, stamp, actionId, input.ifRev, ...who.params,
        ),
        hook(actionLine({ ...at(actorId, nowMs), args: { action: 'action.withdrawn', actionId, by: by.kind } }, stamped(actionId, stamp))),
      ])
      const after = await row(actionId)
      if (after && after.stamp === stamp) return { action: after }
      return refusal('conflict')
    },

    async resolve(actor, actionId, input) {
      const nowMs = d.now()
      const before = await row(actionId)
      if (!before || !mayView(before, actor)) return refusal('not_found')
      if (before.approver !== actor.memberId && actor.role !== 'admin') return refusal('forbidden', 'not_owner')
      const stamp = writeStamp(d.requestId)
      const mine = stamped(actionId, stamp)
      // The use was reserved at the approved revision (the claim moved `rev` on).
      const useRev = before.approved_rev ?? before.rev
      const line = (released: boolean) => ({ ...at(actor.memberId, nowMs), args: { action: 'action.resolved' as const, actionId, outcome: input.outcome, released } })
      const stmts: Stmt[] = [
        stmt(
          `UPDATE outbox_actions SET state = ?, rev = rev + 1, resolved_by = ?, resolved_at_ms = ?, final_at_ms = ?, updated_at_ms = ?, stamp = ?
           WHERE id = ? AND rev = ? AND state = 'needs_check' AND approved_rev IS ?
             AND EXISTS (SELECT 1 FROM members m WHERE m.id = ? AND m.kind = 'person' AND m.status = 'active'
               AND (m.id = outbox_actions.approver OR m.role = 'admin'))`,
          input.outcome, actor.memberId, nowMs, nowMs, nowMs, stamp, actionId, input.ifRev, before.approved_rev, actor.memberId,
        ),
      ]
      if (input.outcome === 'failed') {
        // "It didn't go out": the use goes back.
        stmts.push(
          hook(actionLine(line(true), both(mine, unreleasedUse(actionId, useRev)))),
          hook(actionLine(line(false), butNot(mine, unreleasedUse(actionId, useRev)))),
          releaseUseWhere({ actionId, actionRev: useRev, reason: 'not_sent', atMs: nowMs }, mine),
        )
      } else {
        stmts.push(hook(actionLine(line(false), mine)))
      }
      await runBatch(db, stmts)
      const after = await row(actionId)
      if (after && after.stamp === stamp) return { action: after }
      if (!after || after.rev !== input.ifRev || after.state !== 'needs_check') return refusal('conflict')
      return refusal('forbidden')
    },

    async get(viewer, id) {
      const r = await row(id)
      return r && mayView(r, viewer) ? r : null
    },

    async list(viewer, filter) {
      const where: string[] = []
      const params: SqlValue[] = []
      if (viewer.role !== 'admin') {
        where.push('(asked_by = ? OR approver = ?)')
        params.push(viewer.memberId, viewer.memberId)
      }
      if (filter.states) {
        where.push(`state IN (${filter.states.map(() => '?').join(', ')})`)
        params.push(...filter.states)
      }
      // One chat's cards are its owner's only: an admin's view of another person's card never names the chat.
      if (filter.chatId !== undefined) {
        where.push('chat_id = ? AND asked_by = ?')
        params.push(filter.chatId, viewer.memberId)
      }
      return all<OutboxActionRow>(db, stmt(
        `SELECT * FROM outbox_actions ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at_ms DESC, id DESC LIMIT 200`,
        ...params,
      ))
    },
  }
}

export type OutboxStore = ReturnType<typeof openOutbox>
export type { OutboxActor, OutboxChange }

/**
 * The request's outbox store (db/stores.ts): data in, data out (the store contract), one port per call with that
 * call's request id and clock. It schedules nothing: the route asks BrandAgent for an approved action's send itself.
 */
export function outboxStore({ db, hook }: { db: D1Database; hook?: AuditHook }) {
  const port = (at: { requestId: string; nowMs: number }) => openOutbox({ db, hook, requestId: at.requestId, now: () => at.nowMs, schedule: async () => {} })
  const reads = port({ requestId: 'outbox-read', nowMs: 0 })
  return {
    list: (viewer: Viewer, filter: ActionFilter): Promise<OutboxActionRow[]> => reads.list(viewer, filter),
    get: (viewer: Viewer, id: string): Promise<OutboxActionRow | null> => reads.get(viewer, id),
    answer: (actor: OutboxActor, id: string, input: Parameters<OutboxPort['answer']>[2], at: { requestId: string; nowMs: number }): Promise<OutboxChange> =>
      port(at).answer(actor, id, input),
    undo: (actor: OutboxActor, id: string, input: Parameters<OutboxPort['undo']>[2], at: { requestId: string; nowMs: number }): Promise<OutboxChange> =>
      port(at).undo(actor, id, input),
    resolve: (actor: OutboxActor, id: string, input: Parameters<OutboxPort['resolve']>[2], at: { requestId: string; nowMs: number }): Promise<OutboxChange> =>
      port(at).resolve(actor, id, input),
    /** The health signals' counts (ops/signals/needs-check.ts): open checks, sends past their deadline, the gate. */
    async health(nowMs: number): Promise<{ needsCheck: number; staleSending: number; gate: { paused: boolean; doGen: number; updatedAtMs: number } }> {
      const [counts, gate] = await Promise.all([
        first<{ checks: number; stale: number }>(db, stmt(
          `SELECT SUM(state = 'needs_check') AS checks, SUM(state = 'sending' AND claimed_at_ms <= ?) AS stale FROM outbox_actions
           WHERE state IN ('needs_check', 'sending')`,
          nowMs - timing().staleSendingMs - timing().sweepEveryMs,
        )),
        first<{ paused: number; do_gen: number; updated_at_ms: number }>(db, stmt('SELECT paused, do_gen, updated_at_ms FROM outbox_gate WHERE id = 1')),
      ])
      if (!gate) throw new Error('outbox: the gate row is missing')
      return { needsCheck: counts?.checks ?? 0, staleSending: counts?.stale ?? 0, gate: { paused: gate.paused === 1, doGen: gate.do_gen, updatedAtMs: gate.updated_at_ms } }
    },
  }
}

export type OutboxApiStore = ReturnType<typeof outboxStore>
