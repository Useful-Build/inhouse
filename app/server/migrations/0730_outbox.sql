-- Stage 1 M2-B (N11, N12): the outbox, the only path a write takes. Writes stay off (N2): with no enabled operation in
-- `permission_ceiling`, every request is refused before a row is written here.
-- `outbox_gate`: one row, the truth for D1 about Pause and the restore hold. BrandAgent's pause hook (and the sweep, when
-- the two are out of step) sets `paused` and `do_gen` to the object's state and raises `epoch`, so no approval given
-- before a Pause or a Resume can be claimed after it. `restore_hold` is M2-R's: only the admin's restore confirm clears it.
-- `outbox_actions`: one row per proposed action, through its whole life (waiting, approved, sending, then sent, failed or
-- needs_check; or undone, denied, withdrawn, expired). `rev` moves on every change; an approval binds `approved_rev` to
-- the revision it approved, and the claim needs the two equal. `args_json` holds the parsed arguments (the send needs
-- them); the audit log never does. People by member id only. `stamp` marks the rows a batch changed, so its audit lines
-- go in only where its change applied. `final_at_ms` is null while the action is open (waiting, approved, sending or an
-- unresolved needs_check), so retention, which ages rows by it, never removes an open action. Forward only.
CREATE TABLE outbox_gate (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  restore_hold INTEGER NOT NULL DEFAULT 0 CHECK (restore_hold IN (0, 1)),
  epoch INTEGER NOT NULL DEFAULT 1,
  do_gen INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,
  stamp TEXT);
INSERT INTO outbox_gate (id, updated_at_ms) VALUES (1, 0);

CREATE TABLE outbox_actions (
  id TEXT PRIMARY KEY,                                  -- ac_ + 128 random bits
  rev INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK (state IN ('waiting','approved','sending','sent','failed','needs_check',
                                       'undone','denied','withdrawn','expired')),
  verdict TEXT NOT NULL CHECK (verdict IN ('run','ask','exact')),
  guardrail TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('chat','job','routine')),
  via TEXT NOT NULL CHECK (via IN ('tool','approval_request')),
  asked_by TEXT NOT NULL,
  approver TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  run_id TEXT,
  turn_id TEXT,
  tool_use_id TEXT,
  job_id TEXT,
  account_id TEXT NOT NULL,
  account_gen INTEGER NOT NULL,
  operation TEXT NOT NULL,
  policy_rev INTEGER NOT NULL,
  scope_json TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  args_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  records INTEGER NOT NULL,
  units INTEGER NOT NULL,
  card_json TEXT NOT NULL,
  grant_id TEXT,
  approved_by TEXT,                                     -- a member id, or 'grant:<id>'
  approved_rev INTEGER,
  approved_at_ms INTEGER,
  approved_epoch INTEGER,
  send_at_ms INTEGER,
  claimed_at_ms INTEGER,
  attempt INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  error_code TEXT,
  lapsed_reason TEXT,
  resolved_by TEXT,
  resolved_at_ms INTEGER,
  report TEXT CHECK (report IN ('tool','later','resume','none')),
  expires_at_ms INTEGER NOT NULL,
  final_at_ms INTEGER,                                  -- set on entering a final state; null while open (retention's age)
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  stamp TEXT);
CREATE UNIQUE INDEX outbox_invocation ON outbox_actions(chat_id, tool_use_id) WHERE tool_use_id IS NOT NULL;
CREATE INDEX outbox_due ON outbox_actions(state, send_at_ms);
CREATE INDEX outbox_waiting ON outbox_actions(chat_id, payload_hash) WHERE state = 'waiting';
CREATE INDEX outbox_asked ON outbox_actions(asked_by, created_at_ms);
