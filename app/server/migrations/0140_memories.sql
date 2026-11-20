-- P3 memory (p3-design sections 10 and 11, W6): what the agent remembers. A `brand` fact is the team's and waits for an
-- admin's OK (`waiting`); a `person` fact is its owner's and counts at once (`active`). Forgetting keeps the row
-- (`forgotten`), so an undo can bring it back. `n` is a stable rowid for FTS5's content_rowid (0141).
CREATE TABLE memories (n INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, scope TEXT NOT NULL CHECK (scope IN ('brand','person')),
  owner_id TEXT REFERENCES members(id), text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
  status TEXT NOT NULL CHECK (status IN ('active','waiting','forgotten')), source_chat_id TEXT, created_by TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, used_count INTEGER NOT NULL DEFAULT 0,
  last_used_at_ms INTEGER, rev INTEGER NOT NULL DEFAULT 1, req_id TEXT,
  CHECK ((scope='person' AND owner_id IS NOT NULL) OR (scope='brand' AND owner_id IS NULL)));
CREATE INDEX memories_owner ON memories(owner_id, status, n);
CREATE INDEX memories_scope ON memories(scope, status, n);
