-- All-in job budgets. A job spans its turns' calendar months, not the other way around.
CREATE TABLE usage_jobs (
  job_id TEXT PRIMARY KEY NOT NULL,
  budget_micro INTEGER NOT NULL CHECK (budget_micro > 0),
  reserved_micro INTEGER NOT NULL CHECK (reserved_micro >= 0),
  spent_micro INTEGER NOT NULL CHECK (spent_micro >= 0),
  state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
  created_at_ms INTEGER NOT NULL,
  closed_at_ms INTEGER,
  stamp TEXT NOT NULL
);

ALTER TABLE usage_turns ADD COLUMN job_id TEXT REFERENCES usage_jobs(job_id);
CREATE INDEX usage_turns_job ON usage_turns(job_id) WHERE job_id IS NOT NULL;
