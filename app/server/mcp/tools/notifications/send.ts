// notification_send (p5-w4.md section 2): the agent's only way to tell people something outside the chat. Members get
// their bell in the app (never a Slack DM, never email); listed Slack channels get a post from the Act stage, the run's
// person's bell below it. The run comes from the run token's grant (the call's scope), never from the model.
import { z } from 'zod'
import { LINK_KINDS } from '../../../../shared/notify/links.ts'
import { notifyAgent } from '../../../notify-slack/send.ts'
import type { AgentNoticeResult, RecipientOutcome } from '../../../notify-slack/send.ts'
import { answer, tool } from '../../server/tool.ts'
import type { ToolHandler } from '../../server/tool.ts'
import { deliveryOf } from './deps.ts'

const codePoints = (max: number) => (s: string) => [...s].length <= max

export const NotificationSendInput = z.strictObject({
  to: z.strictObject({
    members: z.array(z.string().min(1).max(80)).min(1).max(20).optional().describe('Member ids: each reaches that person’s bell in the app.'),
    channels: z.array(z.string().min(1).max(81)).min(1).max(3).optional().describe('Names of Slack channels the brand’s admin listed, like "#ops-alerts".'),
  }).refine(t => t.members !== undefined || t.channels !== undefined, 'Give at least one member or channel.'),
  title: z.string().min(1).max(240).refine(codePoints(120), 'At most 120 characters.').describe('A short headline, at most 120 characters.'),
  text: z.string().min(1).max(3000).refine(codePoints(1500), 'At most 1,500 characters.').describe('The message, at most 1,500 characters. Links are removed.'),
  format: z.enum(['message', 'report']).describe('"message" for a short note on one line, "report" to keep line breaks.'),
  link: z.strictObject({
    kind: z.enum(LINK_KINDS),
    id: z.string().min(1).max(64).optional(),
  }).optional().describe('Where "Open in Inhouse" goes: an approval, chat or routine by id, or today or activity.'),
})

const REASON: Record<string, string> = {
  run_cap: 'run_cap (3 Slack posts per run)',
  rate_limited: 'slack_unavailable',
}

function lineFor(r: RecipientOutcome, listed: string[]): string {
  const who = r.kind === 'slack' || r.detail === 'to_bell' ? (r.to.startsWith('#') ? r.to : `#${r.to}`) : r.to
  const again = r.repeat ? ' (the same notice again: nothing new sent)' : ''
  if (r.outcome === 'unknown') return `${who}: unknown: not retried${again}`
  if (r.outcome === 'posted') return `${who}: ${r.detail === 'to_bell' ? 'sent to the bell (Slack starts at Act)' : 'sent'}${again}`
  const reason = r.detail ?? 'slack_unavailable'
  const extra = reason === 'not_listed' ? ` (listed: ${listed.length > 0 ? listed.join(', ') : 'none'})` : ''
  return `${who}: refused: ${REASON[reason] ?? reason}${extra}${again}`
}

function render(out: AgentNoticeResult) {
  const lines = out.recipients.map(r => lineFor(r, out.listed))
  if (out.changed.includes('links')) lines.push('changed: links removed')
  if (out.changed.includes('mentions')) lines.push('changed: mentions escaped')
  if (out.changed.includes('link_dropped')) lines.push('changed: link dropped (its id isn’t valid)')
  return answer(lines.join('\n'), {
    recipients: out.recipients.map(r => ({ to: r.to, kind: r.kind, outcome: r.outcome, ...(r.detail ? { detail: r.detail } : {}), ...(r.repeat ? { repeat: true } : {}) })),
    changed: out.changed,
  })
}

export const notificationSend: ToolHandler = tool({
  input: NotificationSendInput,
  async call(args, scope, deps) {
    const out = await notifyAgent(
      { db: deps.db, delivery: deliveryOf(deps.notify), nowMs: scope.nowMs, requestId: scope.requestId },
      { memberId: scope.memberId, chatId: scope.chatId, runId: scope.runId, turnId: scope.turnId },
      args,
    )
    return render(out)
  },
})
