-- P3 chat files (p3-design sections 8.5 and 11, W3): a chat's attachments (`input`, route 39, saved at once) and the
-- files its turns wrote to `outputs/` (`output`, the egress's PUT, `pending` until the runner's `file_saved` confirms
-- them). One current saved row per path; an older one is superseded (`replaced_at_ms`), never deleted.
CREATE TABLE chat_files (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), kind TEXT NOT NULL CHECK (kind IN ('input','output')),
  path TEXT NOT NULL, name TEXT NOT NULL, content_type TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
  r2_key TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending','saved')), turn_id TEXT, created_by TEXT,
  created_at_ms INTEGER NOT NULL, replaced_at_ms INTEGER);
CREATE UNIQUE INDEX chat_files_current ON chat_files(chat_id, path) WHERE state='saved' AND replaced_at_ms IS NULL;
CREATE INDEX chat_files_turn ON chat_files(turn_id, kind);
