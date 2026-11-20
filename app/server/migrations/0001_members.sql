-- Members: invites, people, the Inhouse team and the service rows (p2-design section 7). Never deleted; a person is
-- pseudonymised in place (P8, decision Q3). Forward only.
CREATE TABLE members (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('person', 'inhouse', 'service')),
  role TEXT CHECK (role IN ('member', 'admin')),
  status TEXT NOT NULL CHECK (status IN ('invited', 'active', 'removed')),
  name TEXT,
  title TEXT,
  email_norm TEXT,
  subject TEXT,
  service_name TEXT CHECK (service_name IN ('smoke', 'system')),
  photo_key TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  invited_by TEXT,
  removed_at_ms INTEGER,
  pseudonymised_at_ms INTEGER,
  req_id TEXT,
  CHECK ((kind = 'person' AND role IS NOT NULL AND service_name IS NULL)
      OR (kind = 'inhouse' AND role IS NULL AND service_name IS NULL)
      OR (kind = 'service' AND service_name IS NOT NULL))
);
CREATE UNIQUE INDEX members_subject ON members(kind, subject) WHERE subject IS NOT NULL;
CREATE UNIQUE INDEX members_open_email ON members(email_norm) WHERE kind = 'person' AND status IN ('invited', 'active');
CREATE UNIQUE INDEX members_service ON members(service_name) WHERE service_name IS NOT NULL;
