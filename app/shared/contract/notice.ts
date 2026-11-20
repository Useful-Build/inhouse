// Notices (what a write or a hold tells the person) and the bell's notifications.
import './jitless.ts'
import { z } from 'zod'
import { AgentErrorCodeSchema, InstantSchema } from './common.ts'

export const AgentNoticeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('approval.sent'), id: z.string(), text: z.string() }),
  /** A change could not be saved (the browser's storage is full). `text` is what to tell the person. */
  z.object({ type: z.literal('save.failed'), text: z.string() }),
  /** A write failed and was taken back. The method's promise rejects with the same AgentError; `text` is what to tell the person. */
  z.object({ type: z.literal('error'), code: AgentErrorCodeSchema, text: z.string() }),
])
export type AgentNotice = z.infer<typeof AgentNoticeSchema>

/** The places a notification can open. */
export const NoticePageSchema = z.enum(['today', 'approvals', 'activity', 'routines', 'library'])
export type NoticePage = z.infer<typeof NoticePageSchema>

/** A bell notification, as the agent sends it. Stable until state changes, like `listFiles()`. */
export const AgentNotificationSchema = z.object({
  /** Changes when what it says changes, so a new count arrives unread. */
  id: z.string(),
  icon: z.string(),
  text: z.string(),
  who: z.string(),
  /** A person's name when one did it: the bell shows their avatar. */
  person: z.string().optional(),
  at: InstantSchema,
  unread: z.boolean(),
  /** It says something is waiting for the person: "You're all caught up" never shows above it. */
  waiting: z.boolean().optional(),
  link: z.discriminatedUnion('to', [
    z.object({ to: z.literal('tool'), key: z.string() }),
    z.object({ to: z.literal('page'), page: NoticePageSchema }),
    z.object({ to: z.literal('chat'), id: z.string() }),
  ]),
})
export type AgentNotification = z.infer<typeof AgentNotificationSchema>
