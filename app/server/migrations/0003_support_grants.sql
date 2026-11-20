-- Support grants (p2-design section 9, BD7): live means ended_at_ms IS NULL AND ends_at_ms > now. Forward only.
CREATE TABLE support_grants (
  id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  ends_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  ended_by TEXT,
  expiry_logged INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 1,
  req_id TEXT,
  CHECK (ends_at_ms > created_at_ms)
);
