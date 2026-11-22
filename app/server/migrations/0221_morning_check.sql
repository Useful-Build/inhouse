-- P4 W3 the morning check's routine (p4-w3.md section 1): one system row in W2's `routines`, every day at 06:00 (the demo's
-- clock), at every stage (`need` 0), catching up for six hours after a missed time. `INSERT OR IGNORE`: a re-applied
-- migration changes nothing. The cursor starts at the migration's time, so a brand migrated at 07:00 runs no 06:00 slot
-- that day and Today says the check hasn't run (stated, not a bug). W2's table has the three times NOT NULL with no
-- default, so each is given: leaving one out would make the INSERT OR IGNORE skip the row silently.
INSERT OR IGNORE INTO routines (
  id, origin, kind, name, instruction, prompt_ref, days_mask, hour, minute, missed, catch_up_within_min, need, enabled,
  creator_id, checked_until_ms, created_at_ms, updated_at_ms, rev
) VALUES (
  'routine-morning-check', 'system', 'morning_check', 'Morning check', 'Reads the store and lists what needs you today.',
  'morning-check', 127, 6, 0, 'catch_up', 360, 0, 1,
  'm_system', CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER),
  CAST(unixepoch('subsec') * 1000 AS INTEGER), 1);
