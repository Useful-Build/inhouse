-- Stage 1 M2-A (N10): what the agent may do without asking. Writes stay off (N2): no row of `permission_ceiling` is
-- seeded and no route writes it in M1 or M2, so with no enabled operation every write is refused (`over_ceiling`).
-- `permission_ceiling`: one row per operation the brand may use at all, its daily ceiling, and `lowered_rev`, raised
-- whenever the ceiling is lowered (a grant made under an older value no longer covers anything).
-- `permission_grants`: "Always allow" grants. `holder` is `member:<id>` (that member's own chats and jobs) or `brand`.
-- At most one live grant per holder, account, operation and scope (the partial index). Lapses are written, not only
-- computed: a revoke sets `revoked_at_ms`, so nothing old comes back to life. People by member id only.
-- `permission_uses`: one reserved use per action revision, released on Undo, a lapse or a definite failure. A day's
-- unreleased units for a grant never pass `MIN(per_day, per_day_max)` (server/permissions/uses.ts). Its key is one
-- column (`<action_id>#<action_rev>`) so retention ages it by a plain rule; `(action_id, action_rev)` stays unique.
-- Forward only.
CREATE TABLE permission_ceiling (
  operation TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  per_day_max INTEGER NOT NULL,
  lowered_rev INTEGER NOT NULL DEFAULT 1,
  updated_at_ms INTEGER NOT NULL,
  updated_by TEXT NOT NULL);

CREATE TABLE permission_grants (
  id TEXT PRIMARY KEY,                                  -- pg_ + 128 random bits
  holder TEXT NOT NULL,                                 -- 'member:<id>' or 'brand'
  holder_member TEXT REFERENCES members(id),            -- null for 'brand'
  account_id TEXT NOT NULL,
  account_gen INTEGER NOT NULL,
  operation TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  per_day INTEGER NOT NULL,
  policy_rev INTEGER NOT NULL,
  granted_by TEXT NOT NULL,
  granted_role TEXT NOT NULL CHECK (granted_role IN ('member', 'admin')),
  ceiling_rev INTEGER NOT NULL,
  source_action TEXT,
  granted_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER,
  revoked_by TEXT,
  revoke_reason TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  stamp TEXT,
  CHECK ((holder = 'brand' AND holder_member IS NULL) OR (holder = 'member:' || holder_member)));
CREATE UNIQUE INDEX permission_grants_live ON permission_grants(holder, account_id, operation, scope_key)
  WHERE revoked_at_ms IS NULL;

CREATE TABLE permission_uses (
  id TEXT PRIMARY KEY CHECK (id = action_id || '#' || action_rev),
  action_id TEXT NOT NULL,
  action_rev INTEGER NOT NULL,
  grant_id TEXT NOT NULL,
  day TEXT NOT NULL,
  units INTEGER NOT NULL,
  at_ms INTEGER NOT NULL,
  released_at_ms INTEGER,
  release_reason TEXT,
  UNIQUE (action_id, action_rev));
CREATE INDEX permission_uses_day ON permission_uses(grant_id, day) WHERE released_at_ms IS NULL;
