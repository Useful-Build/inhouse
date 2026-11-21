// The bell over HTTP (P4 W4, routes 60 and 61): the signed-in member's notifications and the read call.
// `AgentNotificationSchema` (notice.ts) is the item the screen reads; the server adds `body`, plain text only, for the
// notices that carry P5 and P6 content (never a name from our side; the bell shows it as plain text, no HTML, Markdown or links).
import { z } from 'zod'
import { AgentNotificationSchema } from './notice.ts'

export const NotificationItemSchema = AgentNotificationSchema.extend({ body: z.string().min(1).max(2000).optional() })
export type NotificationItem = z.infer<typeof NotificationItemSchema>

/** Route 60: the 50 newest notices this person may see, newest first. */
export const NotificationsListSchema = z.object({ items: z.array(NotificationItemSchema).max(50) })
export type NotificationsList = z.infer<typeof NotificationsListSchema>

/** Route 61's request: the notices opened, or every one listed (at most 100). Ids this person can't see are skipped without an error. */
export const NotificationsReadInputSchema = z.object({ ids: z.array(z.string().min(1).max(200)).min(1).max(100) }).strict()
export type NotificationsReadInput = z.infer<typeof NotificationsReadInputSchema>

/** Route 61's answer. It never says which ids exist. */
export const NotificationsReadResultSchema = z.object({ ok: z.literal(true) })
