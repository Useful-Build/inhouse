// How retention ages each `retention_period` store, by store name. The job throws by name on a `retention_period`
// entry with no rule here, so a store a later phase registers can't be skipped silently. P2 has no such store; C1 adds
// P3 to P5's, F1 P6 and P7's.
import type { TableEntry } from '../tables/types.ts'

/**
 * The decided periods, in days. `chats` and `steps` are the Data and access settings `d:chats` and `d:steps` (their
 * defaults: Wasim, B9, 2026-11-21, "12 months"); the rest are fixed: soft-deleted chats and Library trash 30 days after
 * the deletion or mark (B9), forgotten memories 30 days after their last update (B9; C1 Q15), a Library upload left
 * `pending` after 1 day (p4-w5.md section 2), the egress record after 30 days (P8a: the Watch soak reads a day at a time).
 */
export const DEFAULT_DAYS = { chats: 365, steps: 365, trash: 30, pendingUpload: 1, forgottenMemory: 30, egress: 30 } as const
export type PeriodName = keyof typeof DEFAULT_DAYS

/** One way a row goes by its own age: `column` (epoch ms; `table.column` for another table's) past `period`, when `when` holds. */
export interface Age { column: string; period: PeriodName; when?: string }

export type RetentionRule =
  /**
   * A D1 table: a row goes when `ageColumn` (epoch ms) is strictly before the cutoff. `idColumn` is the table's whole
   * primary key (one column): the run deletes by it in bounded rounds and logs it.
   */
  | { kind: 'd1'; ageColumn: string; idColumn: string }
  /** An R2 prefix: an object goes when its `uploaded` time is strictly before the cutoff; its key is logged. */
  | { kind: 'r2' }
  /** A derived index (FTS5): no rows of its own to age. Its triggers follow its source, and a restore rebuilds it. */
  | { kind: 'derived' }
  /**
   * A store only C1's own job can age: a cascade, a condition, a composite key or an order, or a Durable Object's
   * storage. `ages` lists each way a row goes by its own age; `withParent` names the store whose removal takes it too
   * (a chat's messages go only with their chat). Each runs its job (ops/coverage/chat-watch-connectors/
   * retention-jobs.ts), on any class; a custom rule with no job refuses to plan by name.
   */
  | { kind: 'custom'; ages: readonly Age[]; withParent?: string; why: string }

const steps = (column: string): Age => ({ column, period: 'steps' })

export const retentionRules: Readonly<Record<string, RetentionRule>> = {
  // P3 W1, W3, W6: a chat ages by its last activity, never message by message (B9; C1 Q3).
  chats: {
    kind: 'custom',
    ages: [{ column: 'last_at_ms', period: 'chats' }, { column: 'deleted_at_ms', period: 'trash', when: 'soft-deleted' }],
    why: 'the chat cascade: its files/ and sessions/ objects, then its library_marks (source chat), chat_files, tool_calls and chat_messages, then the chat row and its BrandAgent rows',
  },
  chat_messages: { kind: 'custom', ages: [], withParent: 'chats', why: 'goes only with its chat, so no message of a live chat goes by its own age' },
  chat_messages_fts: { kind: 'derived' },
  tool_calls: { kind: 'custom', ages: [steps('at_ms')], withParent: 'chats', why: 'composite primary key (turn_id, n); also goes with its chat' },
  chat_files: {
    kind: 'custom',
    ages: [{ column: 'library_marks.deleted_at_ms', period: 'trash', when: "a Library-deleted chat output (source = 'chat'): its files/ object, then the row and its mark" }],
    withParent: 'chats',
    why: 'goes with its chat, or 30 days after its Library mark',
  },
  'files/': { kind: 'custom', ages: [], withParent: 'chat_files', why: 'with its chat or its trashed chat_files row, never by object age (B9: no lifecycle rule)' },
  'sessions/': { kind: 'custom', ages: [], withParent: 'chats', why: 'with its chat, never by object age (B9: no lifecycle rule)' },
  BrandAgent: {
    kind: 'custom',
    ages: [{ column: 'runs.ended_at_ms', period: 'steps', when: "an ended run's rows (runs.state = 'ended'), never a live run's" }],
    withParent: 'chats',
    why: "the object's own SQLite, through the in-object storage functions (TaskContext.sql); a chat's rows go with the chat",
  },
  // P3 W6 (a config store: only its forgotten facts age).
  memories: {
    kind: 'custom',
    ages: [{ column: 'updated_at_ms', period: 'forgottenMemory', when: "status = 'forgotten'" }],
    why: 'waiting and active (including approved) facts are kept; rejected facts become forgotten and age by this rule; the index follows through its triggers',
  },
  // P4 W2, W3 (the steps group).
  routine_slots: { kind: 'custom', ages: [steps('claimed_at_ms')], why: 'skips a slot a today_items row still references (today_items.slot_key, no ON DELETE: 0220)' },
  today_items: { kind: 'd1', ageColumn: 'created_at_ms', idColumn: 'id' },
  notify_sends: { kind: 'd1', ageColumn: 'at_ms', idColumn: 'id' },
  today_aside: { kind: 'd1', ageColumn: 'at_ms', idColumn: 'item_id' },
  // P4 W4 (the steps group). `activity_no_update` forbids UPDATE only, so DELETE works.
  activity_lines: { kind: 'd1', ageColumn: 'at_ms', idColumn: 'n' },
  notices: { kind: 'custom', ages: [steps('at_ms')], why: 'after their reads: notice_reads references notices' },
  notice_reads: { kind: 'custom', ages: [steps('notices.at_ms')], withParent: 'notices', why: "keyed on its notice's at_ms (a read can't outlive its notice); composite primary key (member_id, notice_id)" },
  // P4 W5: the Library ages by its trash, never by object age.
  library_uploads: {
    kind: 'custom',
    ages: [
      { column: 'created_at_ms', period: 'pendingUpload', when: "state = 'pending'" },
      { column: 'library_marks.deleted_at_ms', period: 'trash', when: 'marked deleted' },
    ],
    why: 'a saved, unmarked upload never goes; its library/ object goes before the row',
  },
  library_marks: {
    kind: 'custom',
    ages: [{ column: 'deleted_at_ms', period: 'trash' }],
    why: "with its file: an upload's library/ object, then its library_uploads row, then the mark; a chat output's files/ object, then its chat_files row, then the mark",
  },
  'library/': { kind: 'custom', ages: [], withParent: 'library_uploads', why: 'with its library_uploads row (deleted first), never by object age (B9: no lifecycle rule)' },
  // P8a: the egress record. `egress_fetches_no_update` forbids UPDATE only, so DELETE works.
  egress_fetches: { kind: 'd1', ageColumn: 'at_ms', idColumn: 'n' },
  // Stage 1 M2-A: a grant's uses count only toward their own day; a year on they count toward nothing.
  permission_uses: { kind: 'd1', ageColumn: 'at_ms', idColumn: 'id' },
  // Stage 1 M2-B: an action goes a period after it became final; `final_at_ms` is null while it's open (waiting, approved,
  // sending or an unresolved check), so an open action never goes by age.
  outbox_actions: { kind: 'd1', ageColumn: 'final_at_ms', idColumn: 'id' },
}

/**
 * The period each `retention_period` store follows (a derived index has none): `chats` or `steps` (the Data and access
 * settings), or a fixed period.
 */
export const retentionGroups: Readonly<Record<string, PeriodName>> = {
  chats: 'chats',
  chat_messages: 'chats',
  chat_files: 'trash',
  'files/': 'chats',
  'sessions/': 'chats',
  tool_calls: 'steps',
  BrandAgent: 'steps',
  routine_slots: 'steps',
  today_items: 'steps',
  today_aside: 'steps',
  notify_sends: 'steps',
  activity_lines: 'steps',
  notices: 'steps',
  notice_reads: 'steps',
  library_uploads: 'trash',
  library_marks: 'trash',
  'library/': 'trash',
  egress_fetches: 'egress',
  permission_uses: 'steps',
  outbox_actions: 'steps',
}

export type RetentionPeriods = Readonly<Record<string, number | null>>

/** Days per retention store. Null disables its own age rule. */
export function periodsFor(
  registry: readonly TableEntry[],
  days: Readonly<Record<PeriodName, number | null>> = DEFAULT_DAYS,
): RetentionPeriods {
  const periods: Record<string, number | null> = {}
  for (const e of registry) {
    if (e.retention !== 'retention_period' || e.derived) continue
    const group = retentionGroups[e.name]
    if (group === undefined) throw new Error(`retention: no group for ${e.name} (add one to ops/retention/rules.ts)`)
    periods[e.name] = days[group]
  }
  return periods
}

/** Chats still process trash when their own age rule is disabled. */
export const hasRetentionWork = (store: string, periods: RetentionPeriods) => periods[store] !== null || store === 'chats'
