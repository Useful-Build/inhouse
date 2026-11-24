// The bell's fixed notices (p4-w4 section 2, revisions 3.2): a literal table, one row per template. A row names its
// fields (counts and fixed codes, see ../activity/fields.ts) and fills `{field}` slots at read time; `{person}` is the
// notice's `person_id` rendered from the members table. `body: { max }` marks the templates that may carry plain text
// (P5 and P6 content, in code points); every other template refuses a body. P5 W4 adds its eleven rows here as lines
// only (`notify_message`, `notify_report` at 1,622; the nine system kinds at 300): p5-w4.md section 3.
import type { FieldSpec } from '../activity/fields.ts'

export interface NoticeTemplate {
  /** The notice's producer: stored in `notices.source`. */
  source: string
  /** The notice's headline; `{field}` slots only. */
  text: string
  /** The notice's `who` line. */
  who: string
  fields: FieldSpec
  /**
   * Present on the templates whose notices carry a `body`: the most code points it may hold, and `optional` when a notice
   * of this template may also come without one (P5 W4's system notices; B2, 2026-11-21).
   */
  body?: { max: number; optional?: true }
}

export const NOTICE_TEMPLATES: Readonly<Record<string, NoticeTemplate>> = {
  routine_failed: {
    source: 'routine-slot', text: 'A routine failed', who: 'Your Inhouse agent', fields: { code: 'code' },
  },
  morning_check_found: {
    source: 'morning-check', text: 'The morning check found {items:thing}', who: 'Your Inhouse agent', fields: { items: 'number' },
  },
  // P5 (p5-w4): the agent's notification_send (title and text in `body`) and the server's own notices (sendSystemNotice;
  // the title is the row's, model text only ever in `body`).
  notify_message: { source: 'notify', text: 'Message from your Inhouse agent', who: 'Your Inhouse agent', fields: {}, body: { max: 1622 } },
  notify_report: { source: 'notify', text: 'Report from your Inhouse agent', who: 'Your Inhouse agent', fields: {}, body: { max: 1622 } },
  approval_waiting: { source: 'approvals', text: 'Approval waiting', who: 'Inhouse', fields: {}, body: { max: 300, optional: true } },
  approval_lapsed: { source: 'approvals', text: 'Approval sent back', who: 'Inhouse', fields: {}, body: { max: 300, optional: true } },
  approval_sent: { source: 'approvals', text: 'Approved action sent', who: 'Inhouse', fields: {}, body: { max: 300, optional: true } },
  approval_failed: { source: 'approvals', text: "An approved action didn't go out", who: 'Inhouse', fields: {}, body: { max: 300, optional: true } },
  needs_check: { source: 'approvals', text: 'A send needs a check', who: 'Inhouse', fields: {}, body: { max: 300, optional: true } },
  approval_expired: { source: 'approvals', text: 'An approval expired', who: 'Inhouse', fields: {}, body: { max: 300, optional: true } },
  restore_reconciled: { source: 'approvals', text: 'Sends checked after a restore', who: 'Inhouse', fields: {}, body: { max: 300, optional: true } },
  question_waiting: { source: 'questions', text: 'A question is waiting', who: 'Inhouse', fields: {}, body: { max: 300, optional: true } },
  question_closed: { source: 'questions', text: 'A question was closed', who: 'Inhouse', fields: {}, body: { max: 300, optional: true } },
}
