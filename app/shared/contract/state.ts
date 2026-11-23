// The agent's state a person changes (persisted, resettable), and what a write returns.
import { z } from 'zod'
import { InstantSchema } from './common.ts'
import { MemberIdSchema } from './members.ts'
import { RoutineCardSchema } from './chat.ts'
import { RoutineRunSchema } from './routine.ts'
import { SkillDefSchema } from './skill.ts'

const flags = z.record(z.string(), z.literal(true))

export const ApprovalRecordSchema = z.object({
  /** When it was approved, on the agent's clock (the demo clock in the demo). */
  at: InstantSchema,
  /** Who approved it: the member's id. The name shown comes from the members list. */
  by: MemberIdSchema,
  /** When it was approved on the real clock: the 10 s hold counts from it across reloads. The same as `at` outside the demo. */
  loggedAt: InstantSchema,
  /** Draft title at approval time (partial-aware). History keeps it even if the stage or undo state changes later. */
  title: z.string(),
  /** Final wording once done or sent, taken at approval time. */
  doneText: z.string(),
  /** Whether Inhouse agent had done part of this job by itself when it was approved (Run). Decides the lines and note shown later. */
  partial: z.boolean(),
})
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>

/** What `approve` tells the UI, so it never recomputes the wording. */
export const ApproveResultSchema = z.object({
  record: ApprovalRecordSchema,
  /** True when the 10 s send hold runs. False for reversible drafts. */
  held: z.boolean(),
  doneText: z.string(),
})
export type ApproveResult = z.infer<typeof ApproveResultSchema>

/**
 * A request to the Inhouse team. `sub` is what and who ("New tool · Priya"), `at` when it was asked; `status`
 * is where it stands ("With the team", "Done", "Declined", "Withdrawn"), never a date. Shown as
 * "New tool · Priya, Nov 9". `text` is the request in full, when there is more than the
 * title; `closed` says how a closed request ended (absent while it's open).
 */
export const TeamRequestSchema = z.object({
  icon: z.string(), title: z.string(), sub: z.string(), at: InstantSchema, status: z.string(),
  text: z.string().optional(), closed: z.enum(['done', 'declined', 'withdrawn']).optional(),
})
export type TeamRequest = z.infer<typeof TeamRequestSchema>

/** When and by whom something was done: `at` on the agent's clock, `by` the member's id. */
export const StampRecordSchema = z.object({ at: InstantSchema, by: MemberIdSchema })
export type StampRecord = z.infer<typeof StampRecordSchema>

/** Why a problem left Today and Approvals: snoozed until tomorrow, not a problem, or a draft not to send. */
export const SetAsideReasonSchema = z.enum(['snoozed', 'dismissed', 'declined'])
export type SetAsideReason = z.infer<typeof SetAsideReasonSchema>

/** When and why a problem was set aside. A snooze lasts until the day after `at`; the mock's date never moves, so it keeps it all demo. */
export const SetAsideRecordSchema = z.object({
  reason: SetAsideReasonSchema,
  /** When, on the agent's clock (the demo clock in the demo). */
  at: InstantSchema,
  /** Who set it aside: the member's id. */
  by: MemberIdSchema,
  /** When, on the real clock: orders two set asides at the same demo minute. The same as `at` outside the demo. */
  loggedAt: InstantSchema,
})
export type SetAsideRecord = z.infer<typeof SetAsideRecordSchema>

export const AgentStateSchema = z.object({
  approved: z.record(z.string(), ApprovalRecordSchema),
  /** Approved, held 10 s, now final. */
  sent: flags,
  /** Run: a person undid what Inhouse agent handled: when and who. */
  undone: z.record(z.string(), StampRecordSchema),
  /** Edited draft bodies. */
  edits: z.record(z.string(), z.string()),
  /** When a person paused Inhouse agent, on the agent's clock, or null. */
  paused: InstantSchema.nullable(),
  /** Switches: routines (r:<name>), settings (n:, m:, l:, d:). Missing = default. */
  toggles: z.record(z.string(), z.boolean()),
  routinesExtra: z.array(RoutineCardSchema),
  skillsExtra: z.array(SkillDefSchema),
  requestedTools: flags,
  requestedSkills: flags,
  toolPaused: flags,
  forgot: flags,
  /** Settings dropdowns and text fields, by row key. Missing = the page's default. */
  settings: z.record(z.string(), z.string()),
  teamRequests: z.array(TeamRequestSchema),
  /**
   * Bell notifications read, by id: one a person opened, or every one listed when they chose Mark all as read, so a
   * later notification still arrives unread. A notification whose content changes gets a new id. Phase 2: the agent
   * sends notifications with their own ids.
   */
  readNotices: flags,
  /** Library files a person deleted. */
  libraryDeleted: flags,
  /** Problems a person set aside, by id: snoozed or dismissed on Today, or a draft they chose not to send. Approving one clears it. */
  setAside: z.record(z.string(), SetAsideRecordSchema),
  /** Routines a person deleted, by the routine's `id`. */
  routinesDeleted: flags,
  /** Routines a person ran with Run now, newest first. */
  routineRuns: z.array(RoutineRunSchema),
  // ---------- managing chats ----------
  /** Chat titles a person set, by chat id. Missing = the chat's own title. */
  chatTitles: z.record(z.string(), z.string()),
  /** Pinned chats: listed first, under Pinned in the sidebar. */
  chatPinned: flags,
  /** Chats a person deleted. Soft, so Undo can bring them back; Reset demo clears it. */
  chatDeleted: flags,
})
export type AgentState = z.infer<typeof AgentStateSchema>
