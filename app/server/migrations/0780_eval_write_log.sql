-- Stage 1 M3-R (N30; Q3 = D): the eval write log. Only the eval deployment writes or reads these tables: its hub, the
-- hub's test build, binds this database as EVAL_WRITE_LOG (the eval hub config alone, scripts/check-product-config.mjs
-- `--sandbox --eval --hub`) and serves HUB_WRITE through EvalWriteGateway (hub/testing/eval-write.ts), which sends
-- nothing anywhere and holds no credential: it writes each write request here and answers it. The eval harness's door
-- (evals/targets/write-door.ts) reads the log and sets a fault. Every other deployment has the two tables, empty.
-- `eval_write_log`: one row per request the gateway got, as it got it (the request's own fields; no member name: a
-- WriteRequest carries none), with the answer it gave (`outcome`: `sent`, or the fault it played).
-- `eval_write_fault`: at most one fault per operation, played on its next `remaining` requests (refuse: the upstream
-- refused, nothing went out; unknown: an unclear answer; throttle: Shopify throttled it and nothing ran).
-- Forward only.
CREATE TABLE eval_write_log (
  n INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms INTEGER NOT NULL,
  action_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  args_json TEXT NOT NULL,
  expect_json TEXT NOT NULL,
  item_n INTEGER,
  item_of INTEGER,
  idempotency_key TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('sent', 'refuse', 'unknown', 'throttle')),
  CHECK ((item_n IS NULL) = (item_of IS NULL)));

CREATE TABLE eval_write_fault (
  operation TEXT PRIMARY KEY,
  fault TEXT NOT NULL CHECK (fault IN ('refuse', 'unknown', 'throttle')),
  remaining INTEGER NOT NULL CHECK (remaining >= 0),
  retry_after_ms INTEGER CHECK (retry_after_ms IS NULL OR (fault = 'throttle' AND retry_after_ms BETWEEN 1 AND 86400000)));
