-- Stage 1 M3 (card details, #488; Wasim, 2026-11-27): what an approval card shows beside a write's ids: each order's
-- name, customer and amount, or a draft-order line's product (shared/contract/actions.ts `ActionDetail`). Read from
-- Shopify when the agent asks, cleaned by the server (server/outbox/detail.ts) and kept here as JSON for the card and
-- the batch's item list only. Display only: never in `card_json` or `line`, whose words reach the agent. Null when
-- nothing was read. The rows' retention and export are their tables' (ops/tables/outbox.ts).
-- Forward only: two new nullable columns and two triggers that keep them as written.
ALTER TABLE outbox_actions ADD COLUMN detail_json TEXT;
ALTER TABLE outbox_items ADD COLUMN detail_json TEXT;

-- Written once, at insert: a later statement can't swap what a person saw for something else.
CREATE TRIGGER outbox_actions_detail_fixed BEFORE UPDATE OF detail_json ON outbox_actions
WHEN NEW.detail_json IS NOT OLD.detail_json
BEGIN
  SELECT RAISE(ABORT, 'outbox_actions: detail_json is set at insert only');
END;

CREATE TRIGGER outbox_items_detail_fixed BEFORE UPDATE OF detail_json ON outbox_items
WHEN NEW.detail_json IS NOT OLD.detail_json
BEGIN
  SELECT RAISE(ABORT, 'outbox_items: detail_json is set at insert only');
END;
