// What a person deletion does to each registered store, by store name. The registry's `personKeys` say where a member
// id sits, not what to do with the row, so every store needs a rule here: the job throws by name on an entry with no
// rule, or a rule its retention class doesn't allow, so a store a later phase registers can't be skipped silently.
// C1 and F1 add their stores' rules.
import type { RetentionClass } from '../tables/types.ts'

// `kept` names each of the entry's person keys the rule leaves in place: a reference to the member id, pseudonymous once
// their member row is. Every person key is either acted on or kept (rules.test.ts).
export type DeletionRule =
  /** `account`: the member row is pseudonymised in place by P2's `memberStore.pseudonymise` (the id stays, Q3). */
  | { action: 'pseudonymise'; kept?: readonly string[] }
  /** D1: the rows whose `column` equals the member id are deleted (the rows the person owns). */
  | { action: 'delete_rows'; column: string; kept?: readonly string[] }
  /** R2: every object under the entry's `<memberId>` pattern is deleted. */
  | { action: 'delete_objects' }
  /** Nothing changes; `why` says so for the reviewer. */
  | { action: 'keep'; why: string; kept?: readonly string[] }
  /** A derived index (FTS5): not a store of its own. Its triggers follow its source's deletes, and a restore rebuilds it. */
  | { action: 'derived'; why: string }
  /**
   * A deletion only C1's own runner can do: the chat cascade (objects before rows, children before parents), the bell's
   * ordered delete, the BrandAgent's storage through `BrandAgentRpc.personData`. `deletes` names the person keys whose
   * rows go. Each runs through its part in person.ts; a custom rule no part serves refuses to plan by name, so no run
   * can remove one store's rows and leave another's.
   */
  | { action: 'custom'; deletes: readonly string[]; kept?: readonly string[]; why: string }

export const deletionRules: Readonly<Record<string, DeletionRule>> = {
  // Another member's `invited_by` keeps the id, pseudonymous once this row is.
  members: { action: 'pseudonymise', kept: ['invited_by'] },
  // Personal settings only (owner = the member). A brand setting they changed (`updated_by`) or that names them as an
  // approver (`value_json`) keeps the id, which is pseudonymous once their row is.
  settings: { action: 'delete_rows', column: 'owner', kept: ['updated_by', 'value_json'] },
  support_grants: { action: 'keep', why: 'the brand access history: created_by and ended_by keep the pseudonymous id', kept: ['created_by', 'ended_by'] },
  audit_log: { action: 'keep', why: 'decision Q3: never shortened or edited', kept: ['actor_id', 'target_id', 'args_json:$.memberId', 'args_json:$.replaces', 'args_json:$.value', 'args_json:$.approvedBy'] },
  'photos/': { action: 'delete_objects' },
  'backups/': { action: 'keep', why: 'kept 30 days by the R2 lifecycle rule (Q3)' },
  'restore/': { action: 'keep', why: 'kept 30 days by the R2 lifecycle rule (Q3)' },
  'deletion-log/': { action: 'keep', why: 'the deletion log is never shortened' },

  // P3 W1, W3: the chat cascade over the person's own chats, soft-deleted ones included. A chat's messages, tool calls
  // and files are its owner's: a user message's author and a tool call's member are the turn's owner
  // (server/do/brand-agent/projection.ts), and a chat file's creator is the chat's. For each chat: its files/ and
  // sessions/ objects first (a re-run still finds the chat and its prefixes), then in one D1 batch, children before
  // parents (D1 enforces foreign keys per statement): library_marks (source chat) for its files, chat_files,
  // tool_calls, chat_messages (the search index follows by trigger), then the chat row.
  chats: { action: 'custom', deletes: ['owner_id'], why: 'the chat cascade over the person\'s own chats, soft-deleted ones included' },
  chat_messages: { action: 'custom', deletes: ['author_id'], why: 'with its chat, in the chat cascade' },
  tool_calls: { action: 'custom', deletes: ['member_id'], why: 'with its chat, in the chat cascade' },
  chat_files: { action: 'custom', deletes: ['created_by'], why: 'with its chat, in the chat cascade' },
  'files/': { action: 'custom', deletes: [], why: 'the objects under files/<chatId>/ of the person\'s chats, before their rows (keys name chats, not people)' },
  'sessions/': { action: 'custom', deletes: [], why: 'the transcripts under sessions/<chatId>/ of the person\'s chats, before their rows (keys name chats, not people)' },
  // P3 W1, W2: the object's SQLite through BrandAgentRpc.personData({ personId, mode }) (PERSON_DATA_TABLES in
  // server/do/brand-agent/ports.ts): the person's runs, turns, chat state, run tokens and their runs' events (a
  // `turn.queued` event's `by` is the run's owner). It refuses `busy` while a turn of theirs is live.
  BrandAgent: {
    action: 'custom',
    deletes: ['runs.owner_id', 'turns.owner_id', 'chat_state.owner_id', 'run_tokens.member_id', 'events.json:$.by'],
    kept: ['authority.id', 'flags.value'],
    why: 'personData deletes the person\'s rows; authority.id keeps a removed member\'s id so their sends stay refused (an accepted keep, line A), flags.value (paused_by) keeps the pseudonymous id',
  },
  Runner: { action: 'keep', why: 'holds nothing of a person\'s (p3-design section 11)' },
  // P3 W4: the ledger is the brand's bill.
  usage_months: { action: 'keep', why: 'no person data: the brand\'s monthly bill' },
  usage_turns: { action: 'keep', why: 'the brand\'s bill: member_id is pseudonymous once the member row is', kept: ['member_id'] },
  usage_extends: { action: 'keep', why: 'no person data: a call\'s hold and cost, keyed by its turn' },
  audit_copy_state: { action: 'keep', why: 'no person data: the audit copy\'s cursor' },
  'audit-copy/': { action: 'keep', why: 'decision Q3: the audit log\'s daily copy is never shortened (people by member id only)' },
  // P3 W6: the person's own facts go (a brand fact's owner_id is NULL); the index follows by trigger.
  memories: { action: 'delete_rows', column: 'owner_id', kept: ['created_by'] },
  memories_fts: { action: 'derived', why: 'rebuilt from memories; its triggers follow the deletes' },
  chat_messages_fts: { action: 'derived', why: 'rebuilt from chat_messages; its triggers follow the deletes' },
  // P4 W2, W3: routines run on after their creator is removed (Wasim, 2026-11-19).
  routines: { action: 'keep', why: 'a routine runs on after its creator is removed (Wasim, 2026-11-19): creator_id is pseudonymous; instruction is an accepted keep', kept: ['creator_id'] },
  routine_slots: { action: 'keep', why: 'routine history and Today\'s foreign key: the ids are pseudonymous; prompt_text and result_text are accepted keeps', kept: ['creator_id', 'requested_by'] },
  routine_alerts: { action: 'keep', why: 'no person data: two invariant codes and a count' },
  today_items: { action: 'keep', why: 'store data with no person key; item_json is an accepted keep' },
  today_aside: { action: 'keep', why: 'the team\'s Today state: by is pseudonymous', kept: ['by'] },
  // P4 W4: ids render as "A former member" once the member row is pseudonymised.
  activity_lines: { action: 'keep', why: 'ids only, rendered as A former member once the member row is pseudonymised; no UPDATE needed', kept: ['actor_id', 'subject_id'] },
  notices: {
    action: 'custom',
    deletes: ['audience_member_id'],
    kept: ['person_id'],
    why: 'a notice addressed only to the person (audience = member) goes, after its reads (notice_reads references notices); a team or admin notice keeps person_id and body (an accepted keep)',
  },
  notice_reads: { action: 'delete_rows', column: 'member_id' },
  // P4 W5: the brand's own files.
  library_uploads: { action: 'keep', why: 'the brand\'s own files: created_by is pseudonymous', kept: ['created_by'] },
  library_marks: { action: 'keep', why: 'the brand\'s trash: deleted_by is pseudonymous; a chat output\'s mark goes with the chat cascade', kept: ['deleted_by'] },
  'library/': { action: 'keep', why: 'the brand\'s own files, with their library_uploads rows (keys name files, not people)' },
  // The connector hub (P4 H0; wrangler.hub.jsonc): no member id today (client credentials). P5's per-person connectors
  // add `connectedBy`; the runbook then revokes the connection before a person's deletion runs (C1's PR C).
  SignIn: { action: 'keep', why: 'the brand\'s connector token (client credentials): no person connects it on P4; pending items sweep themselves' },
  // P8a: the egress record names a host, a runner and a container generation, never a member, a run or a turn (one
  // container serves several sessions at once), so no row is a person's; it goes by age in 30 days.
  egress_fetches: { action: 'keep', why: 'no member id: the egress knows the container, not the run; retention removes rows after 30 days. A host can carry data in a subdomain from a refused exfil attempt: kept 30 days, ops-only and not exported. A host over 253 characters is not recorded, only logged' },
}

/** The actions each retention class allows. */
export const ALLOWED: Readonly<Record<RetentionClass, readonly DeletionRule['action'][]>> = {
  audit: ['keep'],
  backup: ['keep'],
  account: ['pseudonymise', 'keep'],
  config: ['delete_rows', 'keep', 'derived'],
  retention_period: ['delete_rows', 'delete_objects', 'keep', 'derived', 'custom'],
  person: ['delete_rows', 'delete_objects'],
}
