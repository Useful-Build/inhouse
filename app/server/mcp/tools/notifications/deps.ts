// What notification_send needs beyond the database. Since Stage 1 M2-N (Q3 = A) its post to a listed Slack channel goes
// through the outbox as `slack.channel.post`, so the tool needs what `approval_request` needs from the egress (the hub's
// word on the accounts, N14's admission, the routine's asker, the chat's `ask` part) plus the send's task on BrandAgent
// for a post a grant approves. The egress builds this with `notifyDeps(notifyWiring(...))` and passes it on without
// looking inside: the egress imports only these two factories, never app/server/notify-slack/** or the hub's contract
// types (a lint rule checks). The tool no longer holds the hub's delivery binding at all: only the server's own notices
// (notify-slack/send.ts `sendSystemNotice`) use `HUB_DELIVERY`, and only the outbox's dispatcher holds the write binding.
import { auditInputSha256 } from '../../../../shared/protocol/index.ts'
import { NOTIFICATION_SEND_TOOL } from '../../../do/brand-agent/invocations.ts'
import type { BrandAgentRpc } from '../../../do/brand-agent/ports.ts'
import type { HubAccountFacts } from '../../../outbox/facts.ts'
import { SEND_KIND, sendTaskId } from '../../../outbox/send-task.ts'
import type { Asker } from '../../../permissions/types.ts'
import type { ToolScope } from '../../server/tool.ts'
import type { ApprovalsWiring } from '../approvals/index.ts'

declare const opaque: unique symbol

/** Opaque outside this folder: built only by `notifyDeps`, read only by the notifications tool. */
export type NotifyDeps = { readonly [opaque]: true }

/** N14's admission for one `notification_send` call: the invocation's `tool_use_id`, the turn's job, and whether it's a replay. */
export interface NotifyAdmitted { toolUseId: string; jobId: string | null; replay: boolean }

/** What the Slack leg needs from the egress (the same seam as `approval_request`'s, plus the send's task). */
export interface NotifyWiring {
  /** The hub's word on each connected account: paused and the label a person reads (outbox/facts.ts). */
  hubAccounts(): Promise<readonly HubAccountFacts[]>
  /**
   * N14's admission: binds this call to an unused call of `notification_send` by the main agent in this live turn, with
   * this input, and marks it used. Null refuses (a helper's call, a hand-made request, a call with other arguments).
   */
  admit(scope: ToolScope, input: unknown): Promise<NotifyAdmitted | null>
  /** A routine's run (`m_system`) asks the routine's creator, if still an active person; null for a system routine. */
  routineAsker(scope: ToolScope): Promise<Asker | null>
  /** A card was made or found for this turn: its `ask` part and the chat's `action.updated`. */
  noted(scope: ToolScope, actionId: string): Promise<void>
  /** Asks BrandAgent to run the send's task at `atMs` (a post a grant approved: it goes after the hold). */
  schedule(actionId: string, atMs: number): Promise<void>
}

type Inside = { wiring: NotifyWiring | null }

/** The tool's deps. `null`: no egress behind the call, so a post to a channel is refused (the bell still works). */
export function notifyDeps(wiring: NotifyWiring | null): NotifyDeps {
  const inside: Inside = { wiring }
  return inside as unknown as NotifyDeps
}

/**
 * The egress's wiring (egress/index.ts): `approval_request`'s seam for the accounts, the routine's asker and the `ask`
 * part, BrandAgent's `admitAction` for this tool's own calls, and its `poke` for the send's task.
 */
export function notifyWiring(
  approvals: Pick<ApprovalsWiring, 'hubAccounts' | 'routineAsker' | 'noted'>,
  d: { rpc: Pick<BrandAgentRpc, 'admitAction' | 'poke'>; log(e: Record<string, unknown>): void },
): NotifyWiring {
  return {
    hubAccounts: () => approvals.hubAccounts(),
    async admit(scope, input) {
      const a = await d.rpc.admitAction(scope.turnId, NOTIFICATION_SEND_TOOL, await auditInputSha256(input))
      if ('refused' in a) {
        d.log({ event: 'actions_not_admitted', turnId: scope.turnId, tool: 'notification_send', why: a.refused })
        return null
      }
      // The admitted turn is the call's own (the run token is the turn's); anything else is a bug, never a way in.
      if (a.turnId !== scope.turnId || a.chatId !== scope.chatId) throw new Error('notification_send: admission answered another turn')
      return { toolUseId: a.toolUseId, jobId: a.jobId, replay: a.replay }
    },
    routineAsker: async scope => (approvals.routineAsker ? approvals.routineAsker(scope) : null),
    noted: async (scope, actionId) => { await approvals.noted?.(scope, actionId) },
    schedule: (actionId, atMs) => d.rpc.poke({ kind: SEND_KIND, id: sendTaskId(actionId), dueAtMs: atMs }),
  }
}

/** The wiring inside, or null (no deps at all, or built without an egress). */
export const wiringOf = (deps: NotifyDeps | undefined): NotifyWiring | null => (deps ? (deps as unknown as Inside).wiring : null)
