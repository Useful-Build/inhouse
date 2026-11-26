// `slack.channel.post` (N9): posts a message to one Slack channel the admin listed (`notify_channels`). The agent names
// the channel; the server maps it to a listed channel's id or refuses `not_listed`. The text gets the same cleaning as
// `notification_send` (shared/notify/bound.ts steps 1, 2 and 4: control characters stripped, links removed, refused
// over the limit, never cut); the hub escapes it once, which makes mentions silent (step 3). Parsing is idempotent, so
// the hub's strict check of the cleaned arguments gives the same text.
import { z } from 'zod'
import { boundBody, TEXT_MAX } from '../../../shared/notify/bound.ts'
import type { ListedChannel } from '../../permissions/types.ts'
import type { OperationEntry } from './types.ts'

/** A channel name as the agent may write it: exact, case-insensitive, an optional leading `#` (send.ts `channelKey`). */
const channelKey = (name: string): string => name.replace(/^#/, '').toLowerCase()

export const PostArgsSchema = z.strictObject({
  channel: z.string().min(1).max(81),
  text: z.string().min(1).max(TEXT_MAX * 4),
}).transform((a, ctx) => {
  const bounded = boundBody(a.text, { escape: false, max: TEXT_MAX })
  if (!bounded.ok) {
    ctx.addIssue({ code: 'custom', path: ['text'], message: bounded.reason })
    return z.NEVER
  }
  return { channel: a.channel, text: bounded.text }
})
export type PostArgs = z.output<typeof PostArgsSchema>

/** The listed channel the agent named, by id or by name. */
export const listedChannel = (channels: readonly ListedChannel[], named: string): ListedChannel | null =>
  channels.find(c => c.id === named) ?? channels.find(c => channelKey(c.name) === channelKey(named)) ?? null

export const slackChannelPost: OperationEntry<PostArgs> & { key: 'slack.channel.post' } = {
  key: 'slack.channel.post',
  tool: 'slack_channel_post',
  description: 'Post a message to one Slack channel the brand listed for notices. Links are removed and mentions stay silent. A person approves it first unless they chose "Always allow".',
  args: PostArgsSchema,
  connector: 'slack',
  scope(a, f): Record<string, string> | { refuse: 'not_listed' } {
    const c = listedChannel(f.listedChannels, a.channel)
    return c ? { channelId: c.id } : { refuse: 'not_listed' }
  },
  records: () => 1,
  units: () => 1,
  effects: { money: false, customer: false, destructive: false, access: false },
  memberMay: true,
  reversible: false,
  idempotent: false,
  defaultPerDay: 50,
  card(a, f) {
    const c = listedChannel(f.listedChannels, a.channel)
    // `resolve` refuses an unlisted channel before it builds the card.
    if (!c) throw new Error('slack.channel.post: card asked for an unlisted channel')
    return { title: `Post to #${c.name} in Slack`, lines: [a.text] }
  },
}
