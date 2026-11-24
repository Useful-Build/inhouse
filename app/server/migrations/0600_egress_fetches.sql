-- P8a: one row per outbound HTTPS request from a runner container, written by the web egress (server/egress/webfetch.ts)
-- before the request goes out (every redirect hop is its own row). The host only: never the path, query, headers or
-- body, which can carry content. The egress knows the runner object and its container generation, not the run or turn
-- (one container serves several sessions at once), so no row names a person. The Watch soak (ops/soak) judges each
-- allowed host against that day's `t:webfetch` list. Append-only (the trigger refuses every UPDATE); retention deletes
-- rows after 30 days. `n` is AUTOINCREMENT: a deleted newest row never has its number reused (the backup reads by
-- rising n). Forward only.
CREATE TABLE egress_fetches (
  n INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms INTEGER NOT NULL,
  host TEXT NOT NULL CHECK (length(host) BETWEEN 1 AND 253),
  verdict TEXT NOT NULL CHECK (verdict IN ('allowed', 'refused')),
  -- The refusal (server/egress/webfetch.ts WebRefusal), exactly when refused.
  code TEXT CHECK ((verdict = 'refused') = (code IS NOT NULL)),
  runner TEXT NOT NULL,
  container_gen INTEGER NOT NULL
);
CREATE INDEX egress_fetches_at ON egress_fetches(at_ms);
CREATE TRIGGER egress_fetches_no_update BEFORE UPDATE ON egress_fetches BEGIN SELECT RAISE(ABORT, 'egress_fetches is append-only'); END;
