-- P3 usage (p3-design sections 9 and 11, W4): the month's cap, holds and spend in micro-USD, each turn's hold and
-- settled cost, each model call's extend and close (idempotent by `(turn_id, call_id)`), and the daily audit copy's
-- cursor. Every ledger write is one D1 batch guarded by a fresh `stamp` (server/usage/ledger.ts). Forward only.
CREATE TABLE usage_months (month TEXT PRIMARY KEY, cap_micro INTEGER NOT NULL, reserved_micro INTEGER NOT NULL DEFAULT 0
  CHECK (reserved_micro >= 0), spent_micro INTEGER NOT NULL DEFAULT 0, last_reserve_micro INTEGER NOT NULL DEFAULT 0,
  alert_crossed_at_ms INTEGER, stamp TEXT);
CREATE TABLE usage_turns (turn_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, chat_id TEXT NOT NULL, member_id TEXT NOT NULL,
  model TEXT NOT NULL, month TEXT NOT NULL REFERENCES usage_months(month), reserved_micro INTEGER NOT NULL,
  settled_micro INTEGER NOT NULL DEFAULT 0, final INTEGER NOT NULL DEFAULT 0, source TEXT CHECK (source IN ('tally')),
  runner_cost_micro INTEGER, created_at_ms INTEGER NOT NULL, settled_at_ms INTEGER, stamp TEXT);
CREATE INDEX usage_turns_month ON usage_turns(month, member_id);
CREATE TABLE usage_extends (turn_id TEXT NOT NULL REFERENCES usage_turns(turn_id), call_id TEXT NOT NULL,
  need_micro INTEGER NOT NULL, actual_micro INTEGER, closed INTEGER NOT NULL DEFAULT 0, at_ms INTEGER NOT NULL,
  PRIMARY KEY (turn_id, call_id));
CREATE TABLE audit_copy_state (id INTEGER PRIMARY KEY CHECK (id = 1), last_id INTEGER NOT NULL, pending_from INTEGER,
  pending_to INTEGER, at_ms INTEGER NOT NULL);
