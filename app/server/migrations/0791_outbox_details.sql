-- Stage 1 M3 (card details, #488; Wasim, 2026-11-27): what an approval card shows beside a write's ids: each order's
-- name, customer and amount, or a draft-order line's product (shared/contract/actions.ts `ActionDetail`). Read from
-- Shopify when the agent asks, cleaned by the server (server/outbox/detail.ts) and kept here as JSON for the card and
-- the batch's item list only. Display only: never in `card_json` or `line`, whose words reach the agent. Null when
-- nothing was read. The rows' retention and export are their tables' (ops/tables/outbox.ts).
-- Forward only: two new nullable columns. Written once, at insert; no statement updates them.
ALTER TABLE outbox_actions ADD COLUMN detail_json TEXT;
ALTER TABLE outbox_items ADD COLUMN detail_json TEXT;

