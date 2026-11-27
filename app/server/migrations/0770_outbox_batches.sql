-- Stage 1 M3-B (N22): batches. A batch is one `outbox_actions` row (`kind = 'batch'`) with an item list in
-- `outbox_items`, one hub call per item. Forward only, additive: every existing row is a `single` action answered by
-- its person, so nothing changes meaning.
-- `items_n`: the tip, the items on a batch's card now. `approved_upto`: the items an approval covers (1 to it); the
-- list is named by `(id, approved_upto)`, and items 1 to it can't change (the trigger below), so an approval binds
-- exactly the writes it showed. `coalesce_key` (operation, account, generation, scope key): set only while a batch
-- collects calls; the unique index keeps one collecting batch per chat and kind. It's cleared whenever the row leaves
-- `waiting` (the trigger below, in the same statement) or reaches `batch_max`, and nothing sets it again, so the index
-- can never block a Pause, a sweep or a lapse.
-- `approver_kind` is M3-X's (N25): single actions only.
ALTER TABLE outbox_actions ADD COLUMN kind TEXT NOT NULL DEFAULT 'single' CHECK (kind IN ('single', 'batch'));
ALTER TABLE outbox_actions ADD COLUMN approver_kind TEXT NOT NULL DEFAULT 'person' CHECK (approver_kind IN ('person', 'admins'));
ALTER TABLE outbox_actions ADD COLUMN items_n INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox_actions ADD COLUMN approved_upto INTEGER;
ALTER TABLE outbox_actions ADD COLUMN coalesce_key TEXT;
CREATE UNIQUE INDEX outbox_open_batch ON outbox_actions(chat_id, coalesce_key) WHERE coalesce_key IS NOT NULL;

-- One item of a batch. `item_id` (`oi_` + random) and the call that made it (`chat_id`, `tool_use_id`) are kept across
-- moves to a new card; `moved_from` names the batch it left. `payload_hash` is hashed in the Worker at insert.
-- `throttles`, `not_before_ms`: an item the upstream throttled (nothing ran) waits and is tried again, at most 5 times.
-- `created_at_ms` bounds the backup's paged read; `final_at_ms` is set once its batch is final (the trigger below), so
-- retention ages items with their batch and never while it's open.
CREATE TABLE outbox_items (
  item_id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL,
  n INTEGER NOT NULL CHECK (n >= 1),
  chat_id TEXT NOT NULL,
  tool_use_id TEXT,
  args_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  line TEXT NOT NULL,
  records INTEGER NOT NULL CHECK (records >= 1),
  units INTEGER NOT NULL CHECK (units >= 1),
  moved_from TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'sent', 'failed', 'needs_check', 'withdrawn')),
  attempt INTEGER NOT NULL DEFAULT 0,
  throttles INTEGER NOT NULL DEFAULT 0,
  not_before_ms INTEGER,
  claimed_at_ms INTEGER,
  result_json TEXT,
  error_code TEXT,
  resolved_by TEXT,
  resolved_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  final_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL,
  stamp TEXT);
CREATE UNIQUE INDEX outbox_items_pos ON outbox_items(action_id, n);
CREATE UNIQUE INDEX outbox_items_call ON outbox_items(chat_id, tool_use_id) WHERE tool_use_id IS NOT NULL;
CREATE INDEX outbox_items_state ON outbox_items(state, claimed_at_ms);
CREATE INDEX outbox_items_stamp ON outbox_items(stamp);

-- Immutable: an item's identity, call, arguments, line and counts never change; its batch, position and `moved_from`
-- change only while it's `pending`, and its position only with its batch (a move to a new card).
CREATE TRIGGER outbox_items_fixed BEFORE UPDATE ON outbox_items
WHEN NEW.item_id IS NOT OLD.item_id OR NEW.chat_id IS NOT OLD.chat_id OR NEW.tool_use_id IS NOT OLD.tool_use_id
  OR NEW.args_json IS NOT OLD.args_json OR NEW.payload_hash IS NOT OLD.payload_hash OR NEW.line IS NOT OLD.line
  OR NEW.records IS NOT OLD.records OR NEW.units IS NOT OLD.units OR NEW.created_at_ms IS NOT OLD.created_at_ms
  OR ((NEW.action_id IS NOT OLD.action_id OR NEW.n IS NOT OLD.n OR NEW.moved_from IS NOT OLD.moved_from)
    AND (OLD.state <> 'pending' OR NEW.state <> 'pending'))
  OR (NEW.n IS NOT OLD.n AND NEW.action_id IS OLD.action_id)
BEGIN
  SELECT RAISE(ABORT, 'outbox_items: an item''s identity, arguments, line and counts are fixed; it moves only while pending');
END;

-- An item moves only into a batch, at a position no approval covers: never into 1 to `approved_upto`. (A new item's
-- insert states the same rule in its own WHERE, server/outbox/batch/rows.ts; inserts carry no trigger, so a restore
-- can put a backup's answered and partly sent batches back as they were.)
CREATE TRIGGER outbox_items_move_free BEFORE UPDATE OF action_id, n ON outbox_items
WHEN (NEW.action_id IS NOT OLD.action_id OR NEW.n IS NOT OLD.n)
  AND NOT EXISTS (SELECT 1 FROM outbox_actions a WHERE a.id = NEW.action_id AND a.kind = 'batch'
    AND (a.approved_upto IS NULL OR NEW.n > a.approved_upto))
BEGIN
  SELECT RAISE(ABORT, 'outbox_items: an item moves only into a batch, after the items an approval covers');
END;

-- `coalesce_key` clears in the same statement whenever a row leaves `waiting` (answered, denied, withdrawn, expired,
-- lapsed or held), whatever statement moved it.
CREATE TRIGGER outbox_actions_stop_collecting AFTER UPDATE OF state ON outbox_actions
WHEN NEW.state <> 'waiting' AND NEW.coalesce_key IS NOT NULL
BEGIN
  UPDATE outbox_actions SET coalesce_key = NULL WHERE id = NEW.id;
END;

-- A batch that becomes final settles its items: any still pending can never be approved on it (`withdrawn`), and every
-- item takes the batch's `final_at_ms` (retention's age), whatever statement ended it.
CREATE TRIGGER outbox_actions_final_items AFTER UPDATE OF final_at_ms ON outbox_actions
WHEN NEW.kind = 'batch' AND NEW.final_at_ms IS NOT NULL AND OLD.final_at_ms IS NULL
BEGIN
  UPDATE outbox_items SET state = CASE WHEN state = 'pending' THEN 'withdrawn' ELSE state END,
    final_at_ms = NEW.final_at_ms, updated_at_ms = NEW.updated_at_ms
  WHERE action_id = NEW.id AND final_at_ms IS NULL;
END;

-- A batch's items go with it (retention, a person's deletion): an item that moved to another card went with that one.
CREATE TRIGGER outbox_actions_delete_items AFTER DELETE ON outbox_actions
WHEN OLD.kind = 'batch'
BEGIN
  DELETE FROM outbox_items WHERE action_id = OLD.id;
END;
