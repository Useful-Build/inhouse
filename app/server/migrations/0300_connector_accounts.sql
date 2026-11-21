-- Connector accounts (P5 W1, p5-w1.md section 9): the product's lifecycle record for the Tools page (who connected and
-- when, "being connected"). The hub's SignIn object stays the truth for the token, the state, `paused` and
-- `needsReconnect`; the Tools page merges both. No token, code or verifier is ever stored here. Rows are created on
-- first use (upsert), none seeded. Member ids only (the Inhouse team are `members` rows of kind 'inhouse'). Forward only.
CREATE TABLE connector_accounts (
  account_id TEXT PRIMARY KEY,          -- the hub's account id, e.g. 'slack:workspace'
  connector TEXT NOT NULL,              -- 'slack', 'shopify'
  last_state TEXT NOT NULL CHECK (last_state IN ('never','connecting','connected','failed','disconnected')),
  last_state_at_ms INTEGER NOT NULL,
  connected_by TEXT REFERENCES members(id), connected_at_ms INTEGER,
  disconnected_by TEXT REFERENCES members(id), disconnected_at_ms INTEGER,
  rev INTEGER NOT NULL DEFAULT 1, req_id TEXT);
