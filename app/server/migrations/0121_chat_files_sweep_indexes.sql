-- The chat file orphan sweep's two lookups (W3 follow-up): the keys of a listed R2 page that some row names (`r2_key IN
-- (...)`), and a keyset page of pending rows past the confirm window. Without them each pass scans every chat_files row.
-- The plans are pinned in files-io/orphan-sweep.test.ts (EXPLAIN QUERY PLAN).
CREATE INDEX chat_files_r2_key ON chat_files(r2_key);
CREATE INDEX chat_files_pending ON chat_files(created_at_ms, id) WHERE state = 'pending';
