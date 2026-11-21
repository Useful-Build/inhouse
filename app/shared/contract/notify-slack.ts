// The Slack channels the brand's admin lists for notices (P5 W4, p5-w4.md section 10): routes F (the list), G (the
// channels the connected person can pick from) and H (save the list). Channel ids and names only; never notice text.
import { z } from 'zod'
import { SlackChannelIdSchema } from './audit.ts'

/** A listed channel. `name` is display only (re-read from Slack on every save); the id is the key. */
export const NotifyChannelSchema = z.object({ channelId: SlackChannelIdSchema, name: z.string().min(1).max(80), alerts: z.boolean() })
export type NotifyChannel = z.infer<typeof NotifyChannelSchema>

/** Route F's answer, and route H's (and H's `conflict` carries it as `current`). `rev` 0: never saved. */
export const NotifyChannelListSchema = z.object({ rev: z.number().int().min(0), channels: z.array(NotifyChannelSchema) })
export type NotifyChannelList = z.infer<typeof NotifyChannelListSchema>

/** Why a channel can't be listed: shared with another organization (Slack Connect), or the connected person isn't in it. */
export const ChannelUnavailableSchema = z.enum(['shared_channel', 'not_member'])

/** Route G: public, unarchived channels; a shared or non-member one comes disabled with its reason. */
export const AvailableChannelSchema = z.object({ channelId: SlackChannelIdSchema, name: z.string().min(1).max(80), disabled: ChannelUnavailableSchema.optional() })
export const AvailableChannelsSchema = z.object({ channels: z.array(AvailableChannelSchema), nextCursor: z.string().nullable() })
export type AvailableChannels = z.infer<typeof AvailableChannelsSchema>

/** Route G's query: the page cursor the last page gave. */
export const AvailableChannelsQuerySchema = z.strictObject({ cursor: z.string().regex(/^[A-Za-z0-9+/=_-]{1,500}$/).optional() })

/** Route H's body: the whole list, the alerts channel (one of the list, or none) and the rev it was read at. */
export const PutNotifyChannelsSchema = z.strictObject({
  channelIds: z.array(SlackChannelIdSchema).max(50),
  /** Absent or null: no alerts channel. */
  alertsChannelId: SlackChannelIdSchema.nullable().optional(),
  ifRev: z.number().int().min(0),
}).refine(b => !b.alertsChannelId || b.channelIds.includes(b.alertsChannelId), { path: ['alertsChannelId'], message: 'The alerts channel must be one of the listed channels' })
export type PutNotifyChannels = z.infer<typeof PutNotifyChannelsSchema>

/**
 * Why route H refused a channel (`conflict`, `reason`, with `current: { channelId }`); `name_taken`: two listed channels
 * would share a lowercase name. A stale `ifRev` is a `conflict` with no reason and the current list as `current`.
 */
export const ChannelRefusalSchema = z.enum(['shared_channel', 'archived', 'not_public', 'not_member', 'not_found', 'name_taken'])
