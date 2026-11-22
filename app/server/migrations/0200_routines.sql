-- P4 W2 (p4-w2.md section 2): routines and their slots. A slot is one scheduled occurrence (`<routineId>|<YYYY-MM-DD>|<HH:MM>`,
-- the brand's local date and scheduled time) or one Run now (`now|<routineId>|<clientKey>`). Slots only move forward
-- (p4-w2.md section 6, the transition table); "newer" is `(local_date, claimed_at_ms)` compared as a pair, never the key.
-- D1 enforces foreign keys (https://developers.cloudflare.com/d1/sql-api/foreign-keys/, read 2026-11-21), so a routine's
-- creator is a real member and a routine's chats are owned by `m_system` (0005).
CREATE TABLE routines (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL CHECK (origin IN ('system','team')),
  kind TEXT NOT NULL DEFAULT 'agent',
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  instruction TEXT NOT NULL CHECK (length(instruction) BETWEEN 1 AND 4000),
  prompt_ref TEXT,
  days_mask INTEGER NOT NULL CHECK (days_mask BETWEEN 1 AND 127),
  hour INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
  minute INTEGER NOT NULL CHECK (minute BETWEEN 0 AND 59),
  missed TEXT NOT NULL CHECK (missed IN ('skip','catch_up')),
  catch_up_within_min INTEGER NOT NULL DEFAULT 360 CHECK (catch_up_within_min BETWEEN 10 AND 1440),
  need INTEGER NOT NULL CHECK (need IN (0,1,2)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  deleted_at_ms INTEGER,
  creator_id TEXT NOT NULL REFERENCES members(id),
  source_chat_id TEXT,
  checked_until_ms INTEGER NOT NULL,
  last_slot_key TEXT,
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1, req_id TEXT,
  CHECK ((origin = 'system' AND prompt_ref IS NOT NULL) OR (origin = 'team' AND prompt_ref IS NULL)));
CREATE INDEX routines_due ON routines(checked_until_ms) WHERE enabled = 1 AND deleted_at_ms IS NULL;
CREATE INDEX routines_recent ON routines(created_at_ms DESC, id DESC);

CREATE TABLE routine_slots (
  slot_key TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL REFERENCES routines(id),
  kind TEXT NOT NULL CHECK (kind IN ('scheduled','manual')),
  local_date TEXT NOT NULL,
  local_time TEXT,
  tz TEXT NOT NULL,
  due_at_ms INTEGER NOT NULL,
  deadline_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('claimed','started','ended','lost','missed','skipped','refused')),
  reason TEXT,
  chat_id TEXT NOT NULL, client_key TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  submit_json TEXT NOT NULL,
  routine_rev INTEGER NOT NULL,
  creator_id TEXT NOT NULL, requested_by TEXT,
  submit_failures INTEGER NOT NULL DEFAULT 0,
  next_attempt_ms INTEGER NOT NULL DEFAULT 0,
  run_id TEXT, turn_id TEXT, outcome TEXT, failure TEXT, result_text TEXT,
  claimed_at_ms INTEGER NOT NULL, started_at_ms INTEGER, ended_at_ms INTEGER);
CREATE INDEX routine_slots_routine ON routine_slots(routine_id, local_date DESC, claimed_at_ms DESC);
CREATE INDEX routine_slots_open ON routine_slots(state, claimed_at_ms) WHERE state IN ('claimed','started');
CREATE UNIQUE INDEX routine_slots_turn ON routine_slots(turn_id) WHERE turn_id IS NOT NULL;
CREATE UNIQUE INDEX routine_slots_one_manual ON routine_slots(routine_id)
  WHERE kind = 'manual' AND state IN ('claimed','started');

-- The tick's invariant alarms (p4-w2.md section 11): `key_reused` (P3 answered conflict/key_reused for a slot's own key)
-- and `tz_invalid` (the brand's g:tz isn't a zone this runtime knows). One row per code, its last time and a count; the
-- routines signal is red while one is under 24 hours old. No person data.
CREATE TABLE routine_alerts (
  code TEXT PRIMARY KEY CHECK (code IN ('key_reused','tz_invalid')),
  last_at_ms INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1);
