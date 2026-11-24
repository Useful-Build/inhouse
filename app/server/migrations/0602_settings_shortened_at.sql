-- P8a R (#370 review): remember when a retention setting (d:chats, d:steps) was shortened, so only shortening opens
-- the 26-hour overdue-check grace window; lengthening or rewriting the same value never opens or extends it. Forward only.
ALTER TABLE settings ADD COLUMN shortened_at_ms INTEGER;
