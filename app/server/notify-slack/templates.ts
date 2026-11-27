// The server's own notice kinds (p5-w4.md section 3a): one fixed title per kind, read from P4's notice templates
// (app/server/notices/templates.ts), so the bell and Slack never disagree. The caller can't pass a title; model text
// only ever goes in the bounded `body`.
import { NOTICE_TEMPLATES } from '../notices/templates.ts'

export const SYSTEM_NOTICE_KINDS = [
  'approval_waiting', 'approval_lapsed', 'approval_sent', 'approval_failed', 'needs_check', 'approval_expired',
  'restore_reconciled', 'question_waiting', 'question_closed',
  // Stage 1 M2-N: a failed routine's alerts-channel copy (routines/end.ts keeps its own bell notices).
  'routine_failed',
] as const
export type StoredSystemKind = (typeof SYSTEM_NOTICE_KINDS)[number]
/** What a caller may pass: the ten, plus P6's `question_asked`, stored and rendered as `question_waiting`. */
export type SystemNoticeKind = StoredSystemKind | 'question_asked'

/** The kind as stored (the alias resolved), or null for anything else. */
export function storedKind(kind: unknown): StoredSystemKind | null {
  if (kind === 'question_asked') return 'question_waiting'
  return typeof kind === 'string' && (SYSTEM_NOTICE_KINDS as readonly string[]).includes(kind) ? (kind as StoredSystemKind) : null
}

/** The kind's title: its notice template's text. Fails loud when P4's table lacks the row. */
export function systemTitle(kind: StoredSystemKind): string {
  const t = NOTICE_TEMPLATES[kind]
  if (!t) throw new Error(`notify-slack: no notice template for ${kind}`)
  return t.text
}

/** The Slack text of a system notice sent without a body: code text, never the caller's. */
export const NO_BODY_TEXT = 'Open Inhouse for the details.'
