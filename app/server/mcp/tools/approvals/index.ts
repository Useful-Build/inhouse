// The approval tools (Stage 1 M2-E; N11, N14, N15): `approval_request`, `approval_get`, `approval_list` and
// `approval_withdraw`, as the run's person (the chat's owner) and nobody else.
//  - `approval_request` goes through the outbox's `request` in `ask_only` mode: it only ever makes a card (or returns the
//    one already waiting). It never waits for the answer and never runs under a grant, so nothing goes out until the
//    person approves it. With no operation enabled in the ceiling (N2, every deployable build) it is refused.
//  - `approval_get` and `approval_list` read only this person's own actions, never an admin's wider view.
//  - `approval_withdraw` moves this chat's own `waiting` action to `withdrawn`.
// `approval_request` needs two things only the egress has: the hub's word on each account (pause, label) and N14's
// admission (this call bound to the main agent's own call in this turn). M2-D wires both from the egress through the
// tool deps (`ToolDeps.approvals`, egress/actions.ts `approvalsWiring`); a call without that wiring is refused with a
// fixed text. A routine's run asks the routine's creator (N15). Results are fixed texts plus ids and the card's own server
// words; the outbox's audit lines hold ids only.
import { z } from 'zod'
import { ActionIdSchema, ActionStateSchema } from '../../../../shared/contract/actions.ts'
import type { ActionState } from '../../../../shared/contract/actions.ts'
import type { MemberRole } from '../../../../shared/contract/members.ts'
import type { Asker } from '../../../permissions/types.ts'
import { SYSTEM_MEMBER_ID } from '../../../db/ids.ts'
import { first, stmt } from '../../../db/sql.ts'
import { cardsOf, itemState } from '../../../outbox/card.ts'
import type { Viewer } from '../../../outbox/card.ts'
import { outboxFacts } from '../../../outbox/facts.ts'
import type { HubAccountFacts } from '../../../outbox/facts.ts'
import { operationForTool } from '../../../outbox/operations/index.ts'
import { openOutbox } from '../../../outbox/store.ts'
import type { OutboxActionRow } from '../../../outbox/types.ts'
import { REFUSAL_TEXT } from '../../../outbox/words.ts'
import { answer, refusal, tool } from '../../server/tool.ts'
import type { InhouseToolName, ToolDeps, ToolHandler, ToolScope } from '../../server/tool.ts'
import { TEXT } from './words.ts'

/** The most approvals `approval_list` returns. */
export const LIST_MAX = 50

/**
 * `approval_request`'s input. No transforms: the parsed object is the call's input as the model sent it, so M2-D's
 * admission can hash it and match the runner's record of the call.
 */
const RequestInput = z.object({
  operation: z.string().min(1).max(64).describe('The name of the write tool this action would use, for example shopify_order_tag_add.'),
  args: z.record(z.string(), z.unknown()).describe("That write tool's arguments, exactly as you would pass them to it."),
}).strict()
export type ApprovalRequestInput = z.output<typeof RequestInput>

/** What `approval_request` needs from the egress (M2-D builds it: egress/actions.ts `approvalsWiring`). */
export interface ApprovalsWiring {
  /** The hub's word on each connected account: paused and the label a person reads (outbox/facts.ts). */
  hubAccounts(): Promise<readonly HubAccountFacts[]>
  /**
   * N14's admission: binds this call to an unused call of `approval_request` by the main agent in this live turn, with
   * this input, and marks it used. Null refuses (a helper's call, a hand-made request, a replay with other arguments).
   * `jobId` is the job the turn belongs to, if any.
   */
  admit(scope: ToolScope, input: ApprovalRequestInput): Promise<{ toolUseId: string; jobId: string | null } | null>
  /**
   * M2-D (N15): a routine's run (`m_system`) asks the routine's creator, if still an active person; null for a system
   * routine (`decide` then refuses, `no_one_to_ask`). Absent: every routine run is refused.
   */
  routineAsker?(scope: ToolScope): Promise<Asker | null>
  /** M2-D (N14): a card was made or found for this turn: its `ask` part and the chat's `action.updated`. */
  noted?(scope: ToolScope, actionId: string): Promise<void>
}

/**
 * The tools never ask for a send. This is not the guard: the outbox's `request` turns a `run` into an `ask` under
 * `ask_only` (store.ts `decide`), and that clamp is what keeps an approval_request from being approved. The store logs and
 * swallows a failed schedule, and the sweep would still send an approved row, so throwing here only makes such a call
 * loud in the logs.
 */
const neverSchedules = async (actionId: string): Promise<void> => {
  throw new Error(`approval tools: asked to schedule a send for ${actionId}, which ask_only never approves`)
}

/** The run's person as an active member, or null. */
async function activePerson(db: D1Database, memberId: string): Promise<{ memberId: string; role: MemberRole } | null> {
  const row = await first<{ role: MemberRole }>(db, stmt("SELECT role FROM members WHERE id = ? AND kind = 'person' AND status = 'active'", memberId))
  return row ? { memberId, role: row.role } : null
}

/** A row's state as the person would see it now: a waiting card past its 7 days is expired, before the sweep says so. */
const stateOf = (row: OutboxActionRow, nowMs: number): ActionState =>
  row.state === 'waiting' && row.expires_at_ms <= nowMs ? 'expired' : row.state

/** An action as the agent reads it: ids, the state and the card's own server words. Never the hub's result. */
async function view(db: D1Database, row: OutboxActionRow, scope: ToolScope) {
  const [card] = await cardsOf(db, [row], { memberId: row.asked_by, role: 'member' }, scope.nowMs)
  if (!card) throw new Error(`approval tools: no card for ${row.id}`)
  return {
    approval_id: row.id,
    status: stateOf(row, scope.nowMs),
    title: card.title,
    lines: card.lines,
    tool: card.tool.label,
    records: card.records,
    asked: card.askedAt.iso,
    this_chat: row.chat_id === scope.chatId,
    ...(card.lapsed !== undefined ? { lapsed: card.lapsed } : {}),
    ...(card.batch !== undefined ? { items: card.batch.itemCount } : {}),
  }
}

/**
 * The outbox as this person reads it. The viewer is always given the member's view, whatever their role: an admin's
 * wider view of other people's cards belongs to Approvals (N15), never to a chat's agent.
 */
function reader(deps: ToolDeps, scope: ToolScope) {
  const port = openOutbox({ db: deps.db, requestId: scope.requestId, now: () => scope.nowMs, schedule: neverSchedules })
  const viewer: Viewer = { memberId: scope.memberId, role: 'member' }
  const mine = (row: OutboxActionRow | null) => (row && row.asked_by === scope.memberId ? row : null)
  return {
    port,
    get: async (id: string) => mine(await port.get(viewer, id)),
    // Filtered on the state the agent is shown: a waiting card past its 7 days that the sweep hasn't moved yet is
    // `expired`, so it's read with the stored `waiting` rows and kept under `expired`, never under `waiting`.
    list: async (status: ActionState | undefined) =>
      (await port.list(viewer, status ? { states: status === 'expired' ? ['expired', 'waiting'] : [status] } : {}))
        .filter(r => r.asked_by === scope.memberId && (status === undefined || stateOf(r, scope.nowMs) === status))
        .slice(0, LIST_MAX),
  }
}

export function approvalHandlers(wiringOf: (deps: ToolDeps) => ApprovalsWiring | null): Partial<Record<InhouseToolName, ToolHandler>> {
  return {
    approval_request: tool({
      input: RequestInput,
      async call(a, scope, deps) {
        const wiring = wiringOf(deps)
        if (!wiring) return refusal('not_switched_on', TEXT.notSwitchedOn)
        const admitted = await wiring.admit(scope, a)
        if (!admitted) return refusal('not_admitted', TEXT.notAdmitted)
        const operation = operationForTool(a.operation)
        if (!operation) return refusal('unknown_operation', REFUSAL_TEXT.unknown_operation)
        // A routine's own run (`m_system`) asks the routine's creator (N15); a system routine has no one: `decide` refuses
        // it (`no_one_to_ask`).
        const system = scope.memberId === SYSTEM_MEMBER_ID
        const asker = system ? (wiring.routineAsker ? await wiring.routineAsker(scope) : null) : await activePerson(deps.db, scope.memberId)
        if (!system && !asker) return refusal('no_one_to_ask', TEXT.noPerson)
        const port = openOutbox({
          db: deps.db, requestId: scope.requestId, now: () => scope.nowMs, schedule: neverSchedules,
          facts: outboxFacts({ db: deps.db, hubAccounts: wiring.hubAccounts }),
        })
        const r = await port.request(
          {
            asker, origin: system ? 'routine' : admitted.jobId !== null ? 'job' : 'chat', chatId: scope.chatId, nowMs: scope.nowMs,
            invocation: { runId: scope.runId, turnId: scope.turnId, toolUseId: admitted.toolUseId }, jobId: admitted.jobId,
          },
          { operation, args: a.args },
          { mode: 'ask_only' },
        )
        if (r.outcome !== 'refused') await wiring.noted?.(scope, r.action.id)
        switch (r.outcome) {
          case 'refused':
            return refusal(r.reason, r.text)
          case 'waiting':
            return answer(
              r.existing ? TEXT.alreadyWaiting(r.action.id) : r.action.approver_kind === 'admins' ? TEXT.madeForAdmins(r.action.id) : TEXT.made(r.action.id),
              { ...(await view(deps.db, r.action, scope)), created: !r.existing },
            )
          case 'existing':
            return answer(TEXT.replay(r.action.id, stateOf(r.action, scope.nowMs)), { ...(await view(deps.db, r.action, scope)), created: false })
          case 'approved':
            // `ask_only` never runs (store.ts `decide`). Reaching here is a bug in the outbox: fail loud, never report a send.
            throw new Error(`approval_request: the outbox approved ${r.action.id} under ask_only`)
          case 'collected': {
            // Stage 1 M3-B (N22): the request joined one card other calls share. It's answered from its own item: its
            // state, never the card's (other calls' items are on it too).
            const state = itemState(r.item, r.action)
            const text = r.existing ? TEXT.replay(r.action.id, state) : TEXT.collected(r.action.id, r.item.n)
            return answer(text, { ...(await view(deps.db, r.action, scope)), status: state, item: r.item.n, created: !r.existing })
          }
        }
      },
    }),

    approval_get: tool({
      input: z.object({ approval_id: ActionIdSchema.describe('The approval_id approval_request or approval_list gave.') }).strict(),
      async call(a, scope, deps) {
        const row = await reader(deps, scope).get(a.approval_id)
        if (!row) return refusal('not_found', TEXT.notFound)
        return answer(TEXT.status(row.id, stateOf(row, scope.nowMs)), await view(deps.db, row, scope))
      },
    }),

    approval_list: tool({
      input: z.object({ status: ActionStateSchema.optional().describe('Only approvals in this state, for example "waiting".') }).strict(),
      async call(a, scope, deps) {
        const rows = await reader(deps, scope).list(a.status)
        const approvals = []
        for (const r of rows) approvals.push(await view(deps.db, r, scope))
        return answer(rows.length === 0 ? TEXT.none : TEXT.listed(rows.length), { approvals })
      },
    }),

    approval_withdraw: tool({
      input: z.object({ approval_id: ActionIdSchema.describe('The approval_id of a waiting approval this chat asked for.') }).strict(),
      async call(a, scope, deps) {
        const read = reader(deps, scope)
        const row = await read.get(a.approval_id)
        if (!row) return refusal('not_found', TEXT.notFound)
        if (row.chat_id !== scope.chatId) return refusal('forbidden', TEXT.otherChat)
        // Stage 1 M3-B (N22): a collecting batch (no call of its own) is shared by other calls' items; withdrawing it would
        // withdraw them all. One call's own batch (its `tool_use_id` on the row) is that call's, like a single action.
        if (row.kind === 'batch' && row.tool_use_id === null) return refusal('conflict', TEXT.batch)
        const state = stateOf(row, scope.nowMs)
        if (state !== 'waiting') return refusal('conflict', TEXT.notWaiting(row.id, state))
        const r = await read.port.withdraw({ kind: 'agent', chatId: scope.chatId, turnId: scope.turnId }, row.id, { ifRev: row.rev })
        if ('refused' in r) return refusal('conflict', TEXT.changed)
        return answer(TEXT.withdrawn(r.action.id), await view(deps.db, r.action, scope))
      },
    }),
  }
}

/** The served map: `approval_request` runs with the egress's wiring (`ToolDeps.approvals`), else it's refused. */
export const handlers = approvalHandlers(deps => deps.approvals ?? null)
