-- Stage 1 M2-Q (N16): a question the agent asked a person mid-turn, with 2 to 4 options. The turn that asked it ended
-- waiting (the runner deferred its lone `question_ask`), and the answer resumes it. The id is the BrandAgent's id for
-- that wait (`q_` and the asking turn id's random part), so the wait, the question and the resume share one key.
-- One question per tool call: unique on (chat_id, tool_use_id), so the SDK running the call again on the resume reads
-- this row and never asks twice.
-- `asked_of` is a member id, or `admins` for a routine whose creator is no longer an active member (`asked_as` says
-- which rule chose it). The first answer wins: `answer` is written only from `open`, by a compare-and-set.
-- `ended_at_ms` is set when the question leaves `open` (answered, expired or closed): retention ages a question by it,
-- so an open question never goes by age. `delivered_at_ms` is set once the resume turn was taken. `req_id` stamps the
-- write an audit line is guarded by (server/db/audit.ts). No member name.
-- Forward only.
CREATE TABLE questions (
  id TEXT PRIMARY KEY CHECK (id GLOB 'q_*' AND length(id) = 24),
  chat_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  tool_use_id TEXT NOT NULL CHECK (length(tool_use_id) BETWEEN 1 AND 256),
  asked_of TEXT NOT NULL,
  asked_as TEXT NOT NULL CHECK (asked_as IN ('owner', 'creator', 'admins')),
  question TEXT NOT NULL CHECK (length(question) BETWEEN 1 AND 1000),
  options_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'answered', 'expired', 'closed')),
  answer TEXT,
  answered_by TEXT,
  answered_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  delivered_at_ms INTEGER,
  req_id TEXT,
  CHECK ((asked_as = 'admins') = (asked_of = 'admins')),
  CHECK ((answer IS NULL) = (answered_by IS NULL) AND (answer IS NULL) = (answered_at_ms IS NULL)),
  CHECK (state <> 'answered' OR answer IS NOT NULL),
  CHECK (state NOT IN ('open', 'expired') OR answer IS NULL),
  CHECK ((state = 'open') = (ended_at_ms IS NULL)),
  CHECK (delivered_at_ms IS NULL OR answer IS NOT NULL),
  UNIQUE (chat_id, tool_use_id));
CREATE INDEX questions_open ON questions(asked_of, created_at_ms) WHERE state = 'open';
