// Outbox Slack channel post (Stage 1 M2-C, N13): reuses `postToSlack` (connectors/slack/post.ts) so every Slack post
// keeps the same channel id check, bounds, single escape, and fixed parameters (`unfurl_links=false`, `unfurl_media=false`).
// Checks paused, connectedAtMs, scopes, and channel eligibility before sending, re-checks them after the awaited channel
// check, and hands `expect` to the SignIn, which re-reads paused, state, scopes and connectedAtMs synchronously right
// before `chat.postMessage` (after its own token gate and channel re-check). Every SignIn answer is read as plain data
// and released (`settledAnswer`, shared/rpc-answer.ts), so no answer that carries a disposer is ever passed on.
import { z } from 'zod'
import type { AccountStatus, HubErrorCode, HubResult, WriteResult } from '../../index/contract'
import { hubError } from '../../index/errors'
import { boundNotice, TEXT_MAX, TITLE_MAX } from '../../../shared/notify/bound'
import type { SlackChannel } from './contract'
import { postToSlack, SLACK_ACCOUNT, type SlackPostStub } from './post'
import { POSTABLE_CHANNEL, refusalFor } from './web'
import { settledAnswer } from '../../../shared/rpc-answer'

export const DEFAULT_OUTBOX_SLACK_TITLE = 'Inhouse'

export const SlackChannelPostArgsSchema = z.strictObject({
  channelId: z.string().regex(POSTABLE_CHANNEL),
  text: z.string().min(1).max(TEXT_MAX),
  title: z.string().min(1).max(TITLE_MAX).optional(),
})
export type SlackChannelPostArgs = z.infer<typeof SlackChannelPostArgsSchema>

export type SlackOutboxStub = SlackPostStub & {
  status(accountId: string): Promise<HubResult<AccountStatus>>
  slackChannelInfo(accountId: string, channelId: string): Promise<HubResult<SlackChannel>>
}

const writeErr = (code: HubErrorCode, sent: 'no' | 'unknown', detail?: string, retryAfterMs?: number): WriteResult => ({
  ok: false,
  error: hubError(code, detail, retryAfterMs),
  sent,
})

/** Errors from `postToSlack` where Slack definitively refused or the hub refused before `chat.postMessage`. */
const DEFINITE_SLACK_NO_SEND = new Set<HubErrorCode>([
  'invalid_args',
  'not_configured',
  'paused',
  'scope_mismatch',
  'key_unavailable',
  'credentials_rejected',
  'connect_refused',
  'connect_stale',
  'rate_limited',
  'upstream_rejected',
])

function checkSlackAccount(status: HubResult<AccountStatus>, expectedConnectedAtMs: number): WriteResult | null {
  if (!status.ok) return { ok: false, error: status.error, sent: 'no' }
  const s = status.value
  if (s.paused) return writeErr('paused', 'no')
  if (s.state === 'failed') return writeErr('credentials_rejected', 'no')
  if (s.state !== 'active') return writeErr('not_configured', 'no')
  if (s.connectedAt === null || s.connectedAt.ms !== expectedConnectedAtMs) {
    return writeErr('connect_stale', 'no', 'connectedAtMs')
  }
  if (s.needsReconnect || !s.scopes.includes('chat:write')) {
    return writeErr('scope_mismatch', 'no', 'missing chat:write')
  }
  return null
}

/**
 * Executes `slack.channel.post` through `postToSlack`.
 * Returns a safe ref (`#<channelName> (<ts>)`), never an upstream body.
 */
export async function postSlackOutboxAction(
  signIn: SlackOutboxStub,
  req: { accountId: string; expect: { connectedAtMs: number }; args: unknown },
): Promise<WriteResult> {
  if (req.accountId !== SLACK_ACCOUNT) return writeErr('invalid_args', 'no', 'accountId')
  const parsed = SlackChannelPostArgsSchema.safeParse(req.args)
  if (!parsed.success) return writeErr('invalid_args', 'no', parsed.error.issues[0]?.path.join('.') || 'args')

  const title = parsed.data.title ?? DEFAULT_OUTBOX_SLACK_TITLE
  const text = parsed.data.text
  const channelId = parsed.data.channelId

  // Pure bounds check first so a doomed post costs no SignIn or Slack call.
  const bounded = boundNotice({ title, text, format: 'report' }, { escape: false })
  if (!bounded.ok) return writeErr('invalid_args', 'no', bounded.reason)

  // Check account state before querying Slack.
  const before = checkSlackAccount(await settledAnswer(signIn.status(SLACK_ACCOUNT)), req.expect.connectedAtMs)
  if (before) return before

  // Verify the channel is still public, unarchived, unshared, and the bot is a member.
  const info = await settledAnswer(signIn.slackChannelInfo(SLACK_ACCOUNT, channelId))
  if (!info.ok) return { ok: false, error: info.error, sent: 'no' }
  const refused = refusalFor(info.value)
  if (refused) return writeErr('connect_refused', 'no', refused)

  // Re-check account state right before posting (after the awaited channel info call).
  const rightBeforePost = checkSlackAccount(await settledAnswer(signIn.status(SLACK_ACCOUNT)), req.expect.connectedAtMs)
  if (rightBeforePost) return rightBeforePost

  const posted = await settledAnswer(postToSlack(signIn, { channelId, title, text }, { connectedAtMs: req.expect.connectedAtMs }))
  if (!posted.ok) {
    const sent = DEFINITE_SLACK_NO_SEND.has(posted.error.code) ? 'no' : 'unknown'
    return { ok: false, error: posted.error, sent }
  }
  return { ok: true, value: { ref: `#${info.value.name} (${posted.value.ts})`.slice(0, 500) } }
}
