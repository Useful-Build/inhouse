-- Stage 1 M3-S2 (N21): the Shopify write store's currency (ISO 4217, upper case), copied from the hub's connect/status
-- answer as the shop handle is (0721). `resolve` refuses a refund in any other currency, and every refund while it's
-- null (fail closed). Read from Shopify's `shop.currencyCode` by the hub; not a secret. Null for every other account.
-- Forward only: a new nullable column, nothing dropped or renamed.
ALTER TABLE connector_accounts ADD COLUMN currency TEXT;
