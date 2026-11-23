-- P4 W5 the Library (p4-w5 section 2). Team uploads (`library_uploads`, bytes in R2 at `library/<id>`) and one mark per
-- listed file (`library_marks`): a delete or restore of a chat output (P3's `chat_files`, never edited here) or of an
-- upload, with the file's revision. A delete is soft (a mark): retention (P8) removes marked files, nothing here does.
-- An upload is `pending` from its row until its bytes are in and sniffed; nothing lists or serves a pending row.
CREATE TABLE library_uploads (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending','saved')),
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at_ms INTEGER NOT NULL,
  req_id TEXT
);
CREATE INDEX library_uploads_recent ON library_uploads(created_at_ms DESC, id DESC) WHERE state = 'saved';
CREATE TABLE library_marks (
  file_id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('chat','upload')),
  deleted_at_ms INTEGER,
  deleted_by TEXT REFERENCES members(id),
  rev INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  req_id TEXT
);
