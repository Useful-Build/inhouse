// `slack.channel.post` (N9): posts a message to one Slack channel the admin listed (`notify_channels`). The agent names
// the channel; the server maps it to a listed channel's id or refuses `not_listed`. The text gets the same cleaning as
// `notification_send` (shared/notify/bound.ts steps 1, 2 and 4: control characters stripped, links removed, refused
// over the limit, never cut); the hub escapes it once, which makes mentions silent (step 3). Parsing is idempotent, so
// the hub's strict check of the cleaned arguments gives the same text.
// Stage 1 M2-N (Q3 = A): `notification_send`'s post to a listed channel is this operation too, so it carries the
// notice's headline as an optional `title` (one line, at most 120 characters, the same cleaning). The hub's post takes it
// as its bold first line (hub/connectors/slack/outbox.ts), else its fixed "Inhouse". Arguments without a title parse,
// hash and post exactly as before, so no grant or action made before it changes meaning.
import { z } from 'zod'
import { boundBody, boundNotice, TEXT_MAX, TITLE_MAX } from '../../../shared/notify/bound.ts'
import type { ListedChannel } from '../../permissions/types.ts'
import type { OperationEntry } from './types.ts'

/** A channel name as the agent may write it: exact, case-insensitive, an optional leading `#` (send.ts `channelKey`). */
const channelKey = (name: string): string => name.replace(/^#/, '').toLowerCase()

export const PostArgsSchema = z.strictObject({
  channel: z.string().min(1).max(81),
  text: z.string().min(1).max(TEXT_MAX * 4),
  title: z.string().min(1).max(TITLE_MAX * 2).optional(),
}).transform((a, ctx): { channel: string; text: string; title?: string } => {
  // The hub's strict schema also caps the raw strings in UTF-16 units (hub/connectors/slack/outbox.ts: `.max(TEXT_MAX)`,
  // `.max(TITLE_MAX)`), which a text of emoji passes here in code points and fails there. Refused here too, before any
  // card: an approved post the hub would only refuse is never asked for.
  const overHub = (field: 'text' | 'title', v: string, max: number) => {
    if (v.length <= max) return false
    ctx.addIssue({ code: 'custom', path: [field], message: 'too_long' })
    return true
  }
  if (a.title === undefined) {
    const bounded = boundBody(a.text, { escape: false, max: TEXT_MAX })
    if (!bounded.ok) {
      ctx.addIssue({ code: 'custom', path: ['text'], message: bounded.reason })
      return z.NEVER
    }
    if (overHub('text', bounded.text, TEXT_MAX)) return z.NEVER
    return { channel: a.channel, text: bounded.text }
  }
  // `report` keeps the text's line breaks, as `boundBody` does; the title is always one line.
  const bounded = boundNotice({ title: a.title, text: a.text, format: 'report' }, { escape: false })
  if (!bounded.ok) {
    ctx.addIssue({ code: 'custom', path: ['text'], message: bounded.reason })
    return z.NEVER
  }
  if (overHub('text', bounded.text, TEXT_MAX) || overHub('title', bounded.title, TITLE_MAX)) return z.NEVER
  return { channel: a.channel, text: bounded.text, title: bounded.title }
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
    return { title: `Post to #${c.name} in Slack`, lines: a.title === undefined ? [a.text] : [a.title, a.text] }
  },
}
