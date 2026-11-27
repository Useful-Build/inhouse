-- Stage 1 M3 (N31; Wasim's option A, 2026-11-27): the eval deployment's fake Slack workspace. Only the eval deployment
-- reads or writes these tables: its hub, the hub's test build, binds this database as EVAL_WRITE_LOG (the eval hub
-- config alone, scripts/check-product-config.mjs `--sandbox --eval --hub`), and while that binding is there its fake
-- Slack MCP server (test/upstreams/mcp/server.ts, through hub/testing/eval-slack.ts) answers every read from these rows
-- instead of the per-PR fixture. No Slack credential and no outside request: the fake is the hub test build's own. The
-- eval harness's door (evals/targets/slack-door.ts) writes them per case: the channels and the planted messages.
-- Which channels the brand listed for posts stays the product's own `notify_channels`. Every other deployment has the
-- two tables, empty.
-- Forward only.
CREATE TABLE eval_slack_channel (
  channel_id TEXT PRIMARY KEY CHECK (channel_id GLOB 'C[A-Z0-9]*' AND length(channel_id) BETWEEN 3 AND 21),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  is_private INTEGER NOT NULL DEFAULT 0 CHECK (is_private IN (0, 1)));
CREATE UNIQUE INDEX eval_slack_channel_name ON eval_slack_channel(lower(name));

CREATE TABLE eval_slack_message (
  ts TEXT PRIMARY KEY CHECK (ts GLOB '[0-9]*.[0-9]*'),
  channel_id TEXT NOT NULL REFERENCES eval_slack_channel(channel_id),
  user_id TEXT NOT NULL CHECK (user_id GLOB 'U[A-Z0-9]*'),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
  thread_ts TEXT);
