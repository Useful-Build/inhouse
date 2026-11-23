-- P6a brand skills (master plan standing decision 6): skills a brand's people make in a chat. The agent saves one with
-- the `skill_save` tool; its maker or an admin changes it the same way, or deletes it (route 85). Every run's start
-- carries the brand's skills to the runner, which writes them root-owned beside our plugin. `name` is unique and follows
-- shared/protocol/brand-skills.ts; `body` is the instructions with no frontmatter. The size rules (25 skills, 192 KiB
-- together) are the store's, checked in the write's own statement. Forward-only; the audit lines hold the id only.
CREATE TABLE brand_skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 64),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 1024),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 12000),
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at_ms INTEGER NOT NULL,
  updated_by TEXT NOT NULL REFERENCES members(id),
  updated_at_ms INTEGER NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1,
  req_id TEXT
);
