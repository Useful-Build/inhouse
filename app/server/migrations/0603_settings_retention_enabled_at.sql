-- Freshness grace starts only when an age rule is enabled after being set to Until deleted.
ALTER TABLE settings ADD COLUMN retention_enabled_at_ms INTEGER;
