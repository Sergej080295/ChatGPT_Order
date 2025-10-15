BEGIN;

DROP TABLE IF EXISTS planner_snapshot_entries CASCADE;
DROP TABLE IF EXISTS planner_state_data CASCADE;
DROP TABLE IF EXISTS planner_state_metadata CASCADE;
DROP TABLE IF EXISTS planner_snapshots CASCADE;
DROP TABLE IF EXISTS planner_state_snapshots CASCADE;
DROP TABLE IF EXISTS planner_state_snapshots_hist CASCADE;
DROP TABLE IF EXISTS revisions CASCADE;

DROP SEQUENCE IF EXISTS revisions_rev_seq CASCADE;

CREATE SEQUENCE revisions_rev_seq;

CREATE TABLE revisions (
  rev BIGINT PRIMARY KEY DEFAULT nextval('revisions_rev_seq'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor TEXT,
  source TEXT,
  note TEXT
);

ALTER SEQUENCE revisions_rev_seq OWNED BY revisions.rev;

CREATE TABLE planner_snapshots (
  rev BIGINT PRIMARY KEY REFERENCES revisions(rev) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX planner_snapshots_hash_key
  ON planner_snapshots(hash);

CREATE TABLE planner_snapshot_entries (
  rev BIGINT NOT NULL REFERENCES planner_snapshots(rev) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('state','meta')),
  path TEXT NOT NULL,
  value_type TEXT NOT NULL CHECK (value_type IN ('object','array','string','number','boolean','null')),
  value_text TEXT,
  value_numeric DOUBLE PRECISION,
  value_boolean BOOLEAN,
  ordinal INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (rev, category, path)
);

CREATE INDEX planner_snapshot_entries_rev_category_path_pattern_idx
  ON planner_snapshot_entries (rev, category, path text_pattern_ops);

CREATE INDEX planner_snapshot_entries_rev_category_ordinal_idx
  ON planner_snapshot_entries (rev, category, ordinal);

COMMIT;
