-- M1-G (N8): keyed HMAC-SHA-256 digests (first 16 bytes, 32-char lowercase hex) of high-signal tokens the agent read
-- through `/hub/`, `/mcp/` or text-like `/files/`. Checked by WebEgress before DNS and on every redirect hop.
-- Brand-wide (the web intercept knows only the container, never a turn or member). Kept 7 days, capped at 50,000 rows
-- (oldest evicted in bounded deletes). Stored as TEXT (hex) rather than BLOB so the backup format
-- (app/ops/backup/format.ts, which rejects BLOB values) and D1 retention handle it cleanly. Forward only.
CREATE TABLE egress_taint (
  digest TEXT PRIMARY KEY CHECK (length(digest) = 32),
  seen_at_ms INTEGER NOT NULL
);
CREATE INDEX egress_taint_seen ON egress_taint(seen_at_ms);
