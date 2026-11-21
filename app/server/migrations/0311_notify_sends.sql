-- P5 W4 (p5-w4.md sections 7 and 8): one row per notice recipient, the caps' counter and the idempotency key. A row is
-- reserved before the send in one statement that checks the caps, so concurrent runs can't pass a cap together; the
-- agent's rows (`source = 'agent'`) and the server's own notices (any other source) are counted apart. No notice text:
-- the hash of the composed notice only (the bell's copy is P4's notice store). Member ids in `actor_id`, and in
-- `target` when `kind = 'bell'`. Forward only.
CREATE TABLE notify_sends (
  id TEXT PRIMARY KEY,                        -- noticeId: 'n_' + 128 random bits
  source TEXT NOT NULL CHECK (source IN ('agent','approvals','questions','routines')),
  run_id TEXT,                                -- the agent's run; for a system notice the causing run when known, else NULL
  system_key TEXT,                            -- the producer's key; NULL for the agent
  turn_id TEXT, actor_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('slack','bell')),
  target TEXT NOT NULL,                       -- channel id or member id or 'admins'
  day TEXT NOT NULL,                          -- UTC date 'YYYY-MM-DD'
  notice_sha256 TEXT NOT NULL,                -- of the composed notice: title, text and link
  outcome TEXT NOT NULL CHECK (outcome IN ('reserved','posted','refused','failed')),
  detail TEXT, slack_ts TEXT, at_ms INTEGER NOT NULL,
  notice_kind TEXT,                           -- the system template kind; NULL for the agent
  CHECK ((source = 'agent' AND run_id IS NOT NULL AND system_key IS NULL AND notice_kind IS NULL)
      OR (source <> 'agent' AND system_key IS NOT NULL AND notice_kind IS NOT NULL)));  -- run_id set when known
CREATE UNIQUE INDEX notify_sends_agent_dedupe ON notify_sends(run_id, kind, target, notice_sha256) WHERE source = 'agent';
CREATE UNIQUE INDEX notify_sends_system_dedupe ON notify_sends(source, system_key, notice_kind, kind, target) WHERE source <> 'agent';
CREATE INDEX notify_sends_day ON notify_sends(source, kind, day);
CREATE INDEX notify_sends_run ON notify_sends(run_id, kind);
