-- The audit log (p2-design section 8, decision Q3): append-only. The triggers refuse every UPDATE and DELETE, and an
-- insert onto an existing id (REPLACE INTO, INSERT OR REPLACE: SQLite's REPLACE deletes the old row without firing
-- the DELETE trigger), so no path (a handler, a later migration, a retention job) can shorten or edit it. Forward only.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id > 0),
  at_ms INTEGER NOT NULL,
  actor_id TEXT NOT NULL REFERENCES members(id),
  action TEXT NOT NULL,
  target_kind TEXT,
  target_id TEXT,
  args_json TEXT NOT NULL DEFAULT '{}',
  req_id TEXT NOT NULL
);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_replace BEFORE INSERT ON audit_log WHEN EXISTS (SELECT 1 FROM audit_log WHERE id = NEW.id) BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
