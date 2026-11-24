-- P5 W4 (p5-w4.md section 7): the Slack channels the brand's admin listed for notices, and at most one alerts channel.
-- The channel id is the key; `name` is display only (re-read from Slack when the list is saved). No notice text here.
-- Member ids only. A removed channel keeps its row (`removed_at_ms`), so the list's history stays readable. Forward only.
CREATE TABLE notify_channels (
  channel_id TEXT PRIMARY KEY CHECK (channel_id GLOB 'C*'),
  name TEXT NOT NULL,                         -- display only; the id is the key
  alerts INTEGER NOT NULL DEFAULT 0 CHECK (alerts IN (0,1)),
  added_by TEXT NOT NULL REFERENCES members(id), added_at_ms INTEGER NOT NULL,
  removed_by TEXT REFERENCES members(id), removed_at_ms INTEGER,
  req_id TEXT);
CREATE UNIQUE INDEX notify_channels_name ON notify_channels(lower(name)) WHERE removed_at_ms IS NULL;
CREATE UNIQUE INDEX notify_channels_alerts ON notify_channels(alerts) WHERE alerts = 1 AND removed_at_ms IS NULL;
CREATE TABLE notify_channel_list (id INTEGER PRIMARY KEY CHECK (id = 1), rev INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
