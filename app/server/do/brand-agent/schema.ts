// The BrandAgent's own tables (p3-design 4.1), created if absent on every start (additive, inside the constructor's
// blockConcurrencyWhile). The scheduler and the run tokens create their own (`due_tasks`, `run_tokens`); the pool its
// `pool_*` (W2). Columns beyond 4.1 and why:
// - `turns.count_tokens_calls`: the CLI's own count_tokens calls (count-tokens.ts, the PR 2 handoff's obligation 3);
// - `turns.requeues`, `pool_queued`, `fence_*`, `grace_until_ms`, `ending_since_ms`, `watch_json`: the recovery rules of
//   1.3 and the fence of 4.6, so nothing that must happen after a reset lives only in memory (N3);
// - `turns.saw_checkpoint`, `mirror_error`, `deferred_json`: 4.5's session rules (a `deferred` counts only with a
//   later checkpoint; a `mirror_error` wins over any checkpoint);
// - `turns.start_json`: the turn's RunStart without its token, so a placement retry mints a fresh token and places the
//   same start (no token in any row); `settled`: the turn's hold was given back (the `call-lease` task);
// - `turns.parts_n`, `steps_n`: the per-turn part and step counters behind the ids `<turnId>.<n>` and `<turnId>.s<n>`;
// - `chat_state.checkpoint_last_uuid_index`: R3's `lastUuidIndex` (#132), passed back in `expect`;
// - `turn_effects`: 4.2.6's awaited side effects (file confirms), one at a time per turn, keyed `(turn_id, seq)`;
// - `turn_trace`: audit and step records for the trace (route 33), never parts;
// - `authority`: the object's removed-member and ended-grant sets (4.3, 4.10).

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
    start_json TEXT, settled INTEGER NOT NULL DEFAULT 0, parts_n INTEGER NOT NULL DEFAULT 0,
    steps_n INTEGER NOT NULL DEFAULT 0, count_tokens_calls INTEGER NOT NULL DEFAULT 0,
    outcome TEXT, failure TEXT, cancel_why TEXT,
    pos_from INTEGER, pos_to INTEGER, d1_flushed INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL, started_at_ms INTEGER, ended_at_ms INTEGER,
    UNIQUE (chat_id, client_key))`)
  sql.exec('CREATE INDEX IF NOT EXISTS turns_run ON turns(run_id, state)')
  sql.exec('CREATE INDEX IF NOT EXISTS turns_state ON turns(state)')
  sql.exec('CREATE INDEX IF NOT EXISTS turns_owner ON turns(owner_id, state)')
  sql.exec(`CREATE TABLE IF NOT EXISTS events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, turn_id TEXT,
    at_ms INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (run_id, seq))`)
  sql.exec(`CREATE TABLE IF NOT EXISTS chat_state (chat_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, live_run_id TEXT,
    session_id TEXT, provider TEXT,
    session TEXT NOT NULL DEFAULT 'none' CHECK (session IN ('none', 'resumable', 'waiting', 'damaged')),
    checkpoint_main_entries INTEGER, checkpoint_last_uuid TEXT, checkpoint_last_uuid_index INTEGER, waiting_json TEXT,
    next_pos INTEGER NOT NULL DEFAULT 0, last_at_ms INTEGER NOT NULL, last_input_tokens INTEGER)`)
  sql.exec('CREATE TABLE IF NOT EXISTS flags (key TEXT PRIMARY KEY, value)')
  sql.exec(`CREATE TABLE IF NOT EXISTS turn_effects (turn_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
    json TEXT NOT NULL, PRIMARY KEY (turn_id, seq))`)
  sql.exec(`CREATE TABLE IF NOT EXISTS turn_trace (turn_id TEXT NOT NULL, n INTEGER NOT NULL, at_ms INTEGER NOT NULL,
    json TEXT NOT NULL, PRIMARY KEY (turn_id, n))`)
  sql.exec(`CREATE TABLE IF NOT EXISTS authority (kind TEXT NOT NULL CHECK (kind IN ('member', 'grant')), id TEXT NOT NULL,
    at_ms INTEGER NOT NULL, PRIMARY KEY (kind, id))`)
}
