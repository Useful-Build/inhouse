-- Stage 1 M3-L (N23, N22): the limits on top of M2's daily count. Forward only, additive.
-- `permission_grants.units_max`: the largest single call a grant lets run (one item, never a batch's total); a bigger
-- call is an exact `count` card. Every grant made before this has 1, M2's one unit per call.
-- `permission_ceiling.units_max`: the largest single call any approval may send (a bigger one is refused `over_limit`
-- at the request, the answer and the claim). `bulk_threshold`: more records than this in one call is an exact `bulk`
-- card (1 to 5; D3's 5 is the most). `batch_max`: the most items one batch card holds (1 to 500). `rev`: the row's
-- revision, the screen's `ifRev`. The defaults are M2's rules, so no row changes meaning.
-- `permission_item_releases`: one batch item's units given back from its batch's one grant use (the item failed
-- definitely, moved to a new card, or was withdrawn), at most once per item and approval. The reservation's daily sum
-- subtracts them while their use is unreleased (server/permissions/uses.ts). Its key is one column
-- (`<action_id>#<action_rev>#<n>`) so retention ages it by a plain rule, as `permission_uses`; `(action_id, action_rev,
-- n)` stays unique.
ALTER TABLE permission_grants ADD COLUMN units_max INTEGER NOT NULL DEFAULT 1;
ALTER TABLE permission_ceiling ADD COLUMN units_max INTEGER NOT NULL DEFAULT 1;
ALTER TABLE permission_ceiling ADD COLUMN bulk_threshold INTEGER NOT NULL DEFAULT 5 CHECK (bulk_threshold BETWEEN 1 AND 5);
ALTER TABLE permission_ceiling ADD COLUMN batch_max INTEGER NOT NULL DEFAULT 500 CHECK (batch_max BETWEEN 1 AND 500);
ALTER TABLE permission_ceiling ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;

CREATE TABLE permission_item_releases (
  id TEXT PRIMARY KEY CHECK (id = action_id || '#' || action_rev || '#' || n),
  action_id TEXT NOT NULL,
  action_rev INTEGER NOT NULL,
  n INTEGER NOT NULL CHECK (n >= 1),
  units INTEGER NOT NULL CHECK (units >= 1),
  reason TEXT NOT NULL CHECK (reason IN ('failed', 'moved', 'withdrawn')),
  at_ms INTEGER NOT NULL,
  UNIQUE (action_id, action_rev, n));
