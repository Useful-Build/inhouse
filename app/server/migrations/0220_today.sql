-- P4 W3 Today (p4-w3.md section 4): the morning check's items and what a person set aside. An item is one problem of one
-- local date (its id hashes the key and the date); `slot_key` names the newest slot that reported it, and "newer" is
-- `(local_date, claimed_at_ms)` as a pair, never the key text. Today shows the shown run's items only (the run is picked
-- from routine_slots at read), so an older slot's late result can't bring a resolved problem back. Forward only.
CREATE TABLE today_items (
  id TEXT PRIMARY KEY, key TEXT NOT NULL, local_date TEXT NOT NULL,
  slot_key TEXT NOT NULL REFERENCES routine_slots(slot_key),
  claimed_at_ms INTEGER NOT NULL,
  run_id TEXT NOT NULL, item_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL);
CREATE INDEX today_items_slot ON today_items(slot_key);
CREATE TABLE today_aside (
  item_id TEXT PRIMARY KEY,
  reason TEXT CHECK (reason IN ('snoozed','dismissed','declined')),
  by TEXT NOT NULL REFERENCES members(id), at_ms INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 1, req_id TEXT);
