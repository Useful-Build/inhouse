-- P3 chats (p3-design section 11, W1's first PR): a person's chats and their messages, the history the BrandAgent
-- projects to D1 at each turn's end. `chat_messages.n` is a stable rowid for FTS5's content_rowid (W6); `extra_json`
-- holds a user message's quote and attachments and an agent part's trace ref.
CREATE TABLE chats (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES members(id), title TEXT NOT NULL,
  custom_title TEXT, pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)), deleted_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL, last_at_ms INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 1, req_id TEXT);
CREATE INDEX chats_owner_recent ON chats(owner_id, last_at_ms DESC, id DESC);
CREATE TABLE chat_messages (n INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, chat_id TEXT NOT NULL REFERENCES chats(id),
  run_id TEXT NOT NULL, turn_id TEXT NOT NULL, pos INTEGER NOT NULL, role TEXT NOT NULL CHECK (role IN ('user','agent','event')),
  author_id TEXT, text TEXT NOT NULL DEFAULT '', part_json TEXT, extra_json TEXT, model TEXT, at_ms INTEGER NOT NULL,
  UNIQUE (chat_id, pos));
