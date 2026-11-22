-- P6a W3 requests to the Inhouse team. One row per request from a person (or their agent): a new tool, a job, a change, a
-- bug or feedback. `subject` is the tool key or skill name a request is about (so the Tools and Skills pages can show
-- "Requested"). `status` leaves `open` once: the Inhouse team marks it done or declined, or the requester withdraws it.
-- Forward-only; the audit lines hold the id, kind and status, never the text.
CREATE TABLE team_requests (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('tool','job','change','bug','feedback')),
  subject TEXT CHECK (subject IS NULL OR length(subject) BETWEEN 1 AND 64),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 1000),
  requested_by TEXT NOT NULL REFERENCES members(id),
  status TEXT NOT NULL CHECK (status IN ('open','done','declined','withdrawn')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1,
  req_id TEXT
);
CREATE INDEX team_requests_status ON team_requests(status, created_at_ms);
