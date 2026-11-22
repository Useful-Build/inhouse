-- P8a F2: Shopify's privacy (compliance) webhooks, one row per request Shopify signed (server/webhooks/shopify-privacy).
-- Three keys keep one request one row: `webhook_id` (Shopify's X-Shopify-Webhook-Id: a retry of one delivery),
-- `body_sha256` while open (the same signed body replayed under fresh ids; once closed, an identical body, a shop's
-- second uninstall say, is a new request) and, while a parsed request is open, the request itself
-- (topic, shop, customer and data request: the same request delivered by the brand's other app). A signed body that
-- doesn't parse is still recorded (`parse_failed` 1, no ids), so nothing Shopify signed is lost. The Shopify ids a
-- request names are kept only while it is open: the Inhouse team needs them to find what to send or erase. Closing it
-- (route 94, the release token) clears them, so a closed row keeps the topic and the dates, never whom it was about.
-- Never a customer's email or phone. Forward only.
CREATE TABLE privacy_requests (
  id TEXT PRIMARY KEY CHECK (id GLOB 'pr_*' AND length(id) = 25),
  webhook_id TEXT NOT NULL UNIQUE CHECK (length(webhook_id) BETWEEN 1 AND 128),
  body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
  topic TEXT NOT NULL CHECK (topic IN ('customers/data_request', 'customers/redact', 'shop/redact')),
  parse_failed INTEGER NOT NULL DEFAULT 0 CHECK (parse_failed IN (0, 1)),
  shop_id INTEGER,
  customer_id TEXT CHECK (customer_id IS NULL OR length(customer_id) BETWEEN 1 AND 32),
  order_ids_json TEXT,
  data_request_id TEXT CHECK (data_request_id IS NULL OR length(data_request_id) BETWEEN 1 AND 32),
  received_at_ms INTEGER NOT NULL,
  -- Shopify's 30 days from receipt.
  due_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at_ms INTEGER,
  req_id TEXT NOT NULL,
  -- A parsed request names its shop; an unparsed one names nothing.
  CHECK ((parse_failed = 0 AND shop_id IS NOT NULL) OR (parse_failed = 1 AND shop_id IS NULL AND customer_id IS NULL AND order_ids_json IS NULL AND data_request_id IS NULL)),
  -- A closed request names nobody.
  CHECK (status = 'open' OR (closed_at_ms IS NOT NULL AND customer_id IS NULL AND order_ids_json IS NULL AND data_request_id IS NULL))
);
CREATE INDEX privacy_requests_open ON privacy_requests(status, received_at_ms);
-- One open row per parsed request, whichever of the brand's two apps delivered it. A customer request without a
-- customer id (Shopify may know the customer by email only, which we never keep) has no key to match on: two such
-- requests stay two rows rather than one being lost.
CREATE UNIQUE INDEX privacy_requests_one_open ON privacy_requests(topic, shop_id, IFNULL(customer_id, ''), IFNULL(data_request_id, ''))
  WHERE status = 'open' AND parse_failed = 0 AND (customer_id IS NOT NULL OR data_request_id IS NOT NULL OR topic = 'shop/redact');
-- The same signed body, while its request is open.
CREATE UNIQUE INDEX privacy_requests_open_body ON privacy_requests(body_sha256) WHERE status = 'open';
