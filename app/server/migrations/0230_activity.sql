-- P4 W4 Activity (p4-w4 section 1): an append-only line store. A line is a template id, its fields (counts and fixed
-- codes, never a name or a member id) and member ids; names are rendered at read time (server/activity/render.ts), so a
-- person deletion needs no UPDATE here. The trigger refuses every UPDATE; retention (P8) deletes by age. Forward only.
CREATE TABLE activity_lines (
  n INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  at_ms INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('read', 'change', 'needs', 'problem')),
  min_stage INTEGER CHECK (min_stage IN (0, 1, 2)),
  template TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  actor_id TEXT REFERENCES members(id),
  subject_id TEXT REFERENCES members(id),
  trace TEXT,
  source TEXT NOT NULL,
  source_key TEXT NOT NULL,
  UNIQUE (source, source_key)
);
CREATE INDEX activity_recent ON activity_lines(at_ms DESC, n DESC);
CREATE TRIGGER activity_no_update BEFORE UPDATE ON activity_lines BEGIN SELECT RAISE(ABORT, 'activity is append-only'); END;
