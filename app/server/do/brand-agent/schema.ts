// The BrandAgent's own tables (p3-design 4.1), created if absent on every start (additive, inside the constructor's
// blockConcurrencyWhile). The scheduler and the run tokens create their own (`due_tasks`, `run_tokens`); the pool its
// `pool_*` (W2). Columns beyond 4.1 and why:
// - `turns.count_tokens_calls`: the CLI's own count_tokens calls (count-tokens.ts, the PR 2 handoff's obligation 3);
// - `turns.claimed_at_ms` (the latest claim: the ambiguous path's 45-minute bound), `requeues`, `pool_queued`,
//   `fence_*`, `grace_until_ms`, `ending_since_ms`, `watch_json`: the recovery rules of
//   1.3 and the fence of 4.6, so nothing that must happen after a reset lives only in memory (N3);
// - `turns.saw_checkpoint`, `mirror_error`, `deferred_json`: 4.5's session rules (a `deferred` counts only with a
//   later checkpoint; a `mirror_error` wins over any checkpoint);
// - `turns.start_json`: the turn's RunStart without its token, so a placement retry mints a fresh token and places the
//   same start (no token in any row); `settled`: the turn's hold was given back (the `call-lease` task);
// - `turns.parts_n`, `steps_n`: the per-turn part and step counters behind the ids `<turnId>.<n>` and `<turnId>.s<n>`;
// - `chat_state.checkpoint_last_uuid_index`: R3's `lastUuidIndex` (#132), passed back in `expect`;
// - `turn_effects`: 4.2.6's awaited side effects (file confirms), one at a time per turn, keyed `(turn_id, seq)`;
// - `turn_trace`: audit and step records for the trace (route 33), never parts;
// - `authority`: the object's removed-member and ended-grant sets (4.3, 4.10);
// - `turn_rows`: a final turn's D1 rows, fixed at its end (4.8, projection.ts), so a retry replays the same ones;
// - `chat_deletion`: each chat route 27 deleted or route 28 restored, with a D1 rev the chat had while deleted (the
//   delete's own, or the one the restore read; a newer delete or a restore at least as new replaces it): `submitTurn`
//   refuses a deleted one, so a send that read the chat in D1 before the delete committed can't start a turn in it;
// - PR 2b, the model gate (8.2): `model_calls` and `ledger_queue` as 4.1, plus `model_calls.n` (the turn's arrival
//   order: FIFO without trusting the clock), `money_wait` (sent back to wait for money: decided again only once a
//   sibling closes), `closed_at_ms` (the trace's end of a call); `turns.ledger_hold_micro` (4.1: the ledger's last
//   answer), `start_hold_micro` (the reserve's answer, the floor of every close's hold), `ledger_fails` and
//   `ledger_retry_at_ms` (a ledger call that failed is sent again from the `call-lease` task, never given up);
//   `chat_state.damaged_at_ms` (the `session_damaged` signal counts damage in the last 24 hours); `turns.runner_cost_micro`
//   (the terminal event's `costUsd`, passed to settle as a cross-check only, never booked).
// - PR 5 (the routine seams): `turns.output_format_json` (the run's structured-output format, into `RunStart`),
//   `on_end_json` (the `{ kind, id }` task the turn's final step ensures), `structured_output_json` (the terminal
//   event's value, at most 64 KiB); added to an older table by `ALTER TABLE` below.
// - PR 6 (the P6 seams): `turns.resume_json` (a resume turn's `{ questionId, decision, toolUseId }`, for protocol v3's
//   `RunStart.deferred`); `turns.abandoned` (a deferred turn whose wait was given up before it was final: its end fires
//   `cancelled` with this reason, and no later checkpoint parks it again); `chat_state.waiting_json` now holds
//   `{ questionId, turnId, toolUseId, toolName, input }` (no older shape exists on a deployed object: pre-launch).
// - A9 (the platform stop): `turns.held_json`, an un-asked `failed stopped|session_crashed` that came before anything
//   ran, held without a `turn.finished` until `released` says whether the turn is placed once more (core.ts `terminal`).
// - P8a S (the Watch switches): `turns.web_search`, `'on'` when the turn may search the web (the Inhouse team's
//   `t:websearch`), else NULL (off; every turn stored before it is off).

import { TURN_ROWS_TABLE } from './projection.ts'

export function createAgentTables(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, owner_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('live', 'ended')), last_seq INTEGER NOT NULL DEFAULT 0,
    started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER)`)
  sql.exec('CREATE INDEX IF NOT EXISTS runs_chat ON runs(chat_id, state)')
  sql.exec(`CREATE TABLE IF NOT EXISTS turns (turn_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, chat_id TEXT NOT NULL,
    owner_id TEXT NOT NULL, ord INTEGER NOT NULL, client_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
    gen INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL CHECK (state IN ('queued', 'starting', 'live', 'ending', 'ended', 'cancelled')),
    priority TEXT NOT NULL CHECK (priority IN ('now', 'next', 'later')), text TEXT NOT NULL, quote TEXT,
    attachments_json TEXT NOT NULL, model TEXT NOT NULL, picker_id TEXT NOT NULL, side_model TEXT NOT NULL,
    effort TEXT NOT NULL, max_turns INTEGER NOT NULL, web_fetch_json TEXT, answer_position TEXT NOT NULL,
    runner TEXT, runner_last_seq INTEGER NOT NULL DEFAULT -1, session_id TEXT,
    last_push_ms INTEGER, last_progress_ms INTEGER, starting_deadline_ms INTEGER, placed INTEGER NOT NULL DEFAULT 0,
    pool_queued INTEGER NOT NULL DEFAULT 0, query_ran INTEGER NOT NULL DEFAULT 0, reserved INTEGER NOT NULL DEFAULT 0,
    interrupt_asked INTEGER NOT NULL DEFAULT 0, budget_wait_since_ms INTEGER, requeues INTEGER NOT NULL DEFAULT 0,
    fenced INTEGER NOT NULL DEFAULT 0, grace_until_ms INTEGER, ending_since_ms INTEGER, watch_json TEXT,
    saw_checkpoint INTEGER NOT NULL DEFAULT 0, mirror_error INTEGER NOT NULL DEFAULT 0, deferred_json TEXT,
    start_json TEXT, settled INTEGER NOT NULL DEFAULT 0, ledger_hold_micro INTEGER NOT NULL DEFAULT 0,
    start_hold_micro INTEGER NOT NULL DEFAULT 0, ledger_fails INTEGER NOT NULL DEFAULT 0, ledger_retry_at_ms INTEGER,
    runner_cost_micro INTEGER, parts_n INTEGER NOT NULL DEFAULT 0,
    steps_n INTEGER NOT NULL DEFAULT 0, count_tokens_calls INTEGER NOT NULL DEFAULT 0,
    outcome TEXT, failure TEXT, cancel_why TEXT, output_format_json TEXT, on_end_json TEXT, structured_output_json TEXT,
    resume_json TEXT, abandoned TEXT, held_json TEXT, web_search TEXT,
    pos_from INTEGER, pos_to INTEGER, d1_flushed INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL, claimed_at_ms INTEGER, started_at_ms INTEGER, ended_at_ms INTEGER,
    UNIQUE (chat_id, client_key))`)
  // PR 5's, PR 6's, A9's and P8a S's columns on an object whose `turns` predates them (CREATE IF NOT EXISTS leaves an existing table as it is).
  const have = new Set(sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('turns')").toArray().map(r => r.name))
  for (const col of ['output_format_json', 'on_end_json', 'structured_output_json', 'resume_json', 'abandoned', 'held_json', 'web_search']) {
    if (!have.has(col)) sql.exec(`ALTER TABLE turns ADD COLUMN ${col} TEXT`)
  }
  sql.exec('CREATE INDEX IF NOT EXISTS turns_run ON turns(run_id, state)')
  sql.exec('CREATE INDEX IF NOT EXISTS turns_state ON turns(state)')
  sql.exec('CREATE INDEX IF NOT EXISTS turns_owner ON turns(owner_id, state)')
  sql.exec(`CREATE TABLE IF NOT EXISTS events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, turn_id TEXT,
    at_ms INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (run_id, seq))`)
  sql.exec(`CREATE TABLE IF NOT EXISTS chat_state (chat_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, live_run_id TEXT,
    session_id TEXT, provider TEXT,
    session TEXT NOT NULL DEFAULT 'none' CHECK (session IN ('none', 'resumable', 'waiting', 'damaged')),
    checkpoint_main_entries INTEGER, checkpoint_last_uuid TEXT, checkpoint_last_uuid_index INTEGER, waiting_json TEXT,
    next_pos INTEGER NOT NULL DEFAULT 0, last_at_ms INTEGER NOT NULL, last_input_tokens INTEGER, damaged_at_ms INTEGER)`)
  sql.exec('CREATE TABLE IF NOT EXISTS flags (key TEXT PRIMARY KEY, value)')
  sql.exec(`CREATE TABLE IF NOT EXISTS turn_effects (turn_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
    json TEXT NOT NULL, PRIMARY KEY (turn_id, seq))`)
  sql.exec(`CREATE TABLE IF NOT EXISTS turn_trace (turn_id TEXT NOT NULL, n INTEGER NOT NULL, at_ms INTEGER NOT NULL,
    json TEXT NOT NULL, PRIMARY KEY (turn_id, n))`)
  sql.exec(`CREATE TABLE IF NOT EXISTS authority (kind TEXT NOT NULL CHECK (kind IN ('member', 'grant')), id TEXT NOT NULL,
    at_ms INTEGER NOT NULL, PRIMARY KEY (kind, id))`)
  sql.exec(`CREATE TABLE IF NOT EXISTS model_calls (turn_id TEXT NOT NULL, call_id TEXT NOT NULL, n INTEGER NOT NULL,
    model TEXT NOT NULL, input_tokens INTEGER NOT NULL, max_tokens INTEGER NOT NULL, modifiers_json TEXT NOT NULL,
    worst_micro INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('waiting', 'deciding', 'granted', 'inflight', 'done', 'cut', 'freed')),
    money_wait INTEGER NOT NULL DEFAULT 0, arrived_at_ms INTEGER NOT NULL, admitted_at_ms INTEGER, granted_at_ms INTEGER,
    lease_until_ms INTEGER, closed_at_ms INTEGER, close_sent INTEGER NOT NULL DEFAULT 0,
    close_answered INTEGER NOT NULL DEFAULT 0, usage_json TEXT, micro INTEGER,
    PRIMARY KEY (turn_id, call_id), UNIQUE (turn_id, n))`)
  sql.exec('CREATE INDEX IF NOT EXISTS model_calls_state ON model_calls(state)')
  sql.exec(`CREATE TABLE IF NOT EXISTS ledger_queue (turn_id TEXT NOT NULL, n INTEGER NOT NULL,
    op TEXT NOT NULL CHECK (op IN ('extend', 'close', 'settle')), call_id TEXT, args_json TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'answered')), answer_json TEXT, PRIMARY KEY (turn_id, n))`)
  sql.exec("CREATE INDEX IF NOT EXISTS ledger_queue_open ON ledger_queue(state) WHERE state != 'answered'")
  sql.exec(TURN_ROWS_TABLE)
  sql.exec(`CREATE TABLE IF NOT EXISTS chat_deletion (chat_id TEXT PRIMARY KEY, deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
    rev INTEGER NOT NULL, at_ms INTEGER NOT NULL)`)
}
