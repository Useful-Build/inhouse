// notification_send's post to a listed Slack channel (Stage 1 M2-N; Wasim, Q3 = A): the same rule as any Slack post.
// Each listed channel the call names is one `slack.channel.post` proposal through the outbox's `request` (the only way a
// write gets in), in `tool` mode: under a live covering grant (the brand's, which an admin gives by marking the channel
// for alerts, or the person's own "Always allow") it's approved and goes after the hold; otherwise it's a card a person
// answers; with the operation off in the ceiling (N2: every deployable build) it's refused and nothing is written.
//
// Admission (N14): the call is bound once, on its first listed channel, to an unused call of `notification_send` by the
// main agent in this live turn with this exact input (a helper's call, a hand-made request, a call with other arguments
// are refused). One call may name up to 3 channels, and the outbox keys an action on `(chat_id, tool_use_id)`, so each
// channel's action takes the invocation's id plus the channel's (`<tool_use_id>#<channel id>`): the same call made again
// (a replay) answers each channel's own action as it is, and a channel the first try didn't ask for is refused, never
// asked afresh. The chat's owner is asked; a routine's run asks its creator (N15), and a system routine has no one to ask.
// The result is never waited on here (a job's or a routine's turn never waits, and a notice shouldn't hold a chat): the
// card is in the chat and in Approvals, and the outcome reaches the agent later, as for `approval_request` (N14 `report`).
import type { MemberRole } from '../../../../shared/contract/members.ts'
import { SYSTEM_MEMBER_ID } from '../../../db/ids.ts'
import { first, stmt } from '../../../db/sql.ts'
import type { ListedChannel, SlackLeg, SlackLegAnswer } from '../../../notify-slack/send.ts'
import { outboxFacts } from '../../../outbox/facts.ts'
import { openOutbox } from '../../../outbox/store.ts'
import type { Asker, Origin } from '../../../permissions/types.ts'
import type { ToolScope } from '../../server/tool.ts'
import type { NotifyAdmitted, NotifyWiring } from './deps.ts'

/** The leg's own refusals (the outbox's come with its words, outbox/words.ts). */
export const LEG_TEXT = {
  notAdmitted: "That call couldn't be matched to this turn, so nothing was asked or sent.",
  noPerson: 'There’s no one to ask for an approval here, so nothing was asked or sent.',
} as const

/** The outbox's invocation key for one channel of one call. */
export const channelInvocation = (toolUseId: string, channelId: string): string => `${toolUseId}#${channelId}`

async function activePerson(db: D1Database, memberId: string): Promise<Asker | null> {
  const row = await first<{ role: MemberRole }>(db, stmt("SELECT role FROM members WHERE id = ? AND kind = 'person' AND status = 'active'", memberId))
  return row ? { memberId, role: row.role } : null
}

/**
 * The Slack leg for one `notification_send` call. `input` is the call's input as the model sent it (the tool's schema has
 * no transforms), hashed for admission as the runner hashed it.
 */
export function slackLeg(wiring: NotifyWiring, db: D1Database, scope: ToolScope, input: unknown): SlackLeg {
  // Admitted once per call, on the first listed channel; every channel after it shares the answer.
  let admission: Promise<NotifyAdmitted | null> | null = null
  let who: Promise<{ asker: Asker | null; origin: Origin } | null> | null = null
  const port = openOutbox({
    db, requestId: scope.requestId, now: () => scope.nowMs,
    facts: outboxFacts({ db, hubAccounts: () => wiring.hubAccounts() }),
    schedule: (actionId, atMs) => wiring.schedule(actionId, atMs),
  })
  const refused = (reason: string, text: string): SlackLegAnswer => ({ kind: 'refused', reason, text })

  return {
    async propose(channel: ListedChannel, post: { title: string; text: string }): Promise<SlackLegAnswer> {
      admission ??= wiring.admit(scope, input)
      const admitted = await admission
      if (!admitted) return refused('not_admitted', LEG_TEXT.notAdmitted)
      who ??= (async () => {
        const system = scope.memberId === SYSTEM_MEMBER_ID
        if (system) return { asker: await wiring.routineAsker(scope), origin: 'routine' as const }
        const asker = await activePerson(db, scope.memberId)
        return asker ? { asker, origin: admitted.jobId !== null ? 'job' as const : 'chat' as const } : null
      })()
      const w = await who
      if (!w) return refused('no_one_to_ask', LEG_TEXT.noPerson)
      const toolUseId = channelInvocation(admitted.toolUseId, channel.channelId)
      // A replay only ever answers this channel's own action from the first try; a channel that try never asked for (it
      // was refused, or not reached) is refused now too, whatever the rules say.
      if (admitted.replay) {
        const prior = await first<{ id: string }>(db, stmt('SELECT id FROM outbox_actions WHERE chat_id = ? AND tool_use_id = ?', scope.chatId, toolUseId))
        if (!prior) return refused('not_admitted', LEG_TEXT.notAdmitted)
      }
      const r = await port.request(
        {
          asker: w.asker, origin: w.origin, chatId: scope.chatId, nowMs: scope.nowMs,
          invocation: { runId: scope.runId, turnId: scope.turnId, toolUseId }, jobId: admitted.jobId,
        },
        { operation: 'slack.channel.post', args: { channel: channel.channelId, title: post.title, text: post.text } },
        { mode: 'tool' },
      )
      if (r.outcome === 'refused') return refused(r.reason, r.text)
      await wiring.noted(scope, r.action.id)
      return {
        kind: 'action', actionId: r.action.id, state: r.action.state, verdict: r.action.verdict,
        created: r.outcome === 'approved' || (r.outcome === 'waiting' && !r.existing),
      }
    },
  }
}
