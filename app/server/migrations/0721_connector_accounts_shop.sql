-- Stage 1 M2-D (N9, from M2-B's #433 and M2-S's #439): the hub is the authority on an account's connection. The product
-- copies the hub's `connectedAt` into `connected_at_ms` (the account generation `resolve`, the claim and the hub's send
-- check all compare) and, for the Shopify account, the handle of the store its writes go to, which the permission scope
-- `{ shop }` needs. A row with no `shop` refuses a Shopify write (fail closed). The handle is a deployment var, not a
-- secret. Forward only: a new nullable column, nothing dropped or renamed.
ALTER TABLE connector_accounts ADD COLUMN shop TEXT;
