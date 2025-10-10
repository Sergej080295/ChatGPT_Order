BEGIN;

CREATE TABLE IF NOT EXISTS planner_state_history (
  id BIGSERIAL PRIMARY KEY,
  hash TEXT NOT NULL,
  etag TEXT NOT NULL,
  state JSONB NOT NULL,
  summary JSONB,
  actor TEXT,
  source TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS planner_state_history_hash_idx ON planner_state_history (hash);
CREATE INDEX IF NOT EXISTS planner_state_history_created_idx ON planner_state_history (created_at DESC);

COMMIT;
