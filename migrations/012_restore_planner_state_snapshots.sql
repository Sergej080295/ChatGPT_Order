BEGIN;

CREATE TABLE IF NOT EXISTS planner_state_snapshots (
  id BIGSERIAL PRIMARY KEY,
  rev BIGINT NOT NULL REFERENCES revisions(rev) ON DELETE CASCADE,
  snapshot JSONB NOT NULL,
  meta JSONB,
  hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS planner_state_snapshots_rev_key
  ON planner_state_snapshots(rev);

CREATE INDEX IF NOT EXISTS planner_state_snapshots_created_idx
  ON planner_state_snapshots(created_at DESC);

COMMIT;
