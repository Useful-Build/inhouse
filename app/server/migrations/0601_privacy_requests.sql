-- P8a F2: Shopify's privacy (compliance) webhooks, one row per delivery Shopify signed (server/webhooks/shopify-privacy).
-- `webhook_id` is Shopify's X-Shopify-Webhook-Id: a retry of the same delivery finds its row and changes nothing. The
-- Shopify ids a request names (the customer, the orders, the data request) are kept only while the request is open: the
-- Inhouse team needs them to find what to send or erase. Closing it (route 94, the release token) clears them, so a
-- closed row keeps the topic and the dates, never whom it was about. Never a customer's email or phone. Forward only.
CREATE TABLE privacy_requests (
  id TEXT PRIMARY KEY CHECK (id GLOB 'pr_*' AND length(id) = 25),
  webhook_id TEXT NOT NULL UNIQUE CHECK (length(webhook_id) BETWEEN 1 AND 128),
  topic TEXT NOT NULL CHECK (topic IN ('customers/data_request', 'customers/redact', 'shop/redact')),
  shop_id INTEGER NOT NULL,
  customer_id TEXT CHECK (customer_id IS NULL OR length(customer_id) BETWEEN 1 AND 32),
  order_ids_json TEXT,
  data_request_id TEXT CHECK (data_request_id IS NULL OR length(data_request_id) BETWEEN 1 AND 32),
  received_at_ms INTEGER NOT NULL,
  -- Shopify's 30 days from receipt.
  due_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at_ms INTEGER,
  req_id TEXT NOT NULL,
  -- A closed request names nobody.
  CHECK (status = 'open' OR (closed_at_ms IS NOT NULL AND customer_id IS NULL AND order_ids_json IS NULL AND data_request_id IS NULL))
);
CREATE INDEX privacy_requests_open ON privacy_requests(status, received_at_ms);
