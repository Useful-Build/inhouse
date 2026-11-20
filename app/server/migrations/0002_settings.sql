-- Settings (p2-design sections 6 and 7): owner is a member id (personal) or 'brand' (brand and technical). Rows are
-- never deleted: a reset stores 'null' and bumps rev, so a stale ifRev can't match a re-created row. Forward only.
CREATE TABLE settings (
  owner TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  rev INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  req_id TEXT NOT NULL,
  PRIMARY KEY (owner, key)
);
