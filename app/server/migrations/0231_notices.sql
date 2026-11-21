-- P4 W4 the bell (p4-w4 section 2): notices and each member's read state. Like Activity, a notice stores a template id,
-- its fields and member ids, and names are rendered at read time. `body` is plain text for P5 and P6 content only (the
-- templates whose row says `body: { max }`, server/notices/templates.ts); it is kept and deleted with its notice, and
-- with the person through `audience_member_id`. Forward only.
CREATE TABLE notices (
  id TEXT PRIMARY KEY,
  audience TEXT NOT NULL CHECK (audience IN ('team', 'admins', 'member')),
  audience_member_id TEXT REFERENCES members(id),
  template TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  body TEXT CHECK (body IS NULL OR length(body) BETWEEN 1 AND 2000),
  icon TEXT NOT NULL,
  person_id TEXT REFERENCES members(id),
  at_ms INTEGER NOT NULL,
  waiting INTEGER NOT NULL DEFAULT 0 CHECK (waiting IN (0, 1)),
  link_json TEXT NOT NULL,
  source TEXT NOT NULL,
  CHECK ((audience = 'member') = (audience_member_id IS NOT NULL))
);
CREATE INDEX notices_recent ON notices(audience, audience_member_id, at_ms DESC);
CREATE TABLE notice_reads (
  member_id TEXT NOT NULL REFERENCES members(id),
  notice_id TEXT NOT NULL REFERENCES notices(id),
  at_ms INTEGER NOT NULL,
  PRIMARY KEY (member_id, notice_id)
);
