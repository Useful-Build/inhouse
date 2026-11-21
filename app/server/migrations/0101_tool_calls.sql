-- P3 tool calls (p3-design 8.7 and 11, W1's second PR): one redacted row per blocking audit entry the root runner posts
-- to the egress's `/audit/` route, written before the hook is acked. The tool's name, the hook, its decision and the
-- input's byte length and SHA-256, never the input itself. Keyed `(turn_id, n)` so a retried post writes nothing new.
CREATE TABLE tool_calls (turn_id TEXT NOT NULL, n INTEGER NOT NULL, chat_id TEXT NOT NULL, member_id TEXT NOT NULL,
  hook TEXT NOT NULL, tool TEXT NOT NULL, tool_use_id TEXT, decision TEXT NOT NULL, input_bytes INTEGER NOT NULL,
  input_sha256 TEXT NOT NULL, at_ms INTEGER NOT NULL, PRIMARY KEY (turn_id, n));
