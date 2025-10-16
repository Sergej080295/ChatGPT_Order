BEGIN;

DROP TABLE IF EXISTS planner_meta_history_entry_attributes CASCADE;
DROP TABLE IF EXISTS planner_meta_history_entries CASCADE;
DROP TABLE IF EXISTS planner_meta_values CASCADE;
DROP TABLE IF EXISTS planner_state_list_entry_attributes CASCADE;
DROP TABLE IF EXISTS planner_state_list_entries CASCADE;
DROP TABLE IF EXISTS planner_state_route_overrides CASCADE;
DROP TABLE IF EXISTS planner_state_ignored_states CASCADE;
DROP TABLE IF EXISTS planner_state_parallel CASCADE;
DROP TABLE IF EXISTS planner_state_capacity CASCADE;
DROP TABLE IF EXISTS planner_state_scalars CASCADE;
DROP TABLE IF EXISTS planner_state_snapshots CASCADE;
DROP TABLE IF EXISTS planner_state_mode_scoped_values CASCADE;
DROP TABLE IF EXISTS planner_state_crm_values CASCADE;
DROP TABLE IF EXISTS planner_settings CASCADE;
DROP TABLE IF EXISTS planner_preferences CASCADE;
DROP TABLE IF EXISTS planner_general_settings CASCADE;
DROP TABLE IF EXISTS planner_snapshot_entries CASCADE;
DROP TABLE IF EXISTS planner_snapshots CASCADE;
DROP TABLE IF EXISTS general_settings CASCADE;

DROP SEQUENCE IF EXISTS planner_state_list_entries_id_seq;
DROP SEQUENCE IF EXISTS planner_meta_history_entries_id_seq;
DROP SEQUENCE IF EXISTS revisions_rev_seq;

DROP TABLE IF EXISTS revisions CASCADE;

CREATE SEQUENCE revisions_rev_seq
  INCREMENT BY 1
  MINVALUE 1
  START WITH 1;

CREATE TABLE revisions (
  id BIGSERIAL PRIMARY KEY,
  rev BIGINT NOT NULL DEFAULT nextval('revisions_rev_seq'),
  current_rev BIGINT NOT NULL DEFAULT currval('revisions_rev_seq'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor TEXT,
  source TEXT,
  note TEXT
);

ALTER SEQUENCE revisions_rev_seq OWNED BY revisions.rev;

CREATE UNIQUE INDEX revisions_rev_unique_idx ON revisions (rev);

CREATE TABLE planner_state_snapshots (
  rev BIGINT PRIMARY KEY REFERENCES revisions(rev) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE planner_state_scalars (
  rev BIGINT NOT NULL REFERENCES planner_state_snapshots(rev) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_type TEXT NOT NULL,
  value_text TEXT,
  value_numeric NUMERIC,
  value_boolean BOOLEAN,
  value_timestamp TIMESTAMPTZ,
  PRIMARY KEY (rev, key)
);

CREATE TABLE planner_state_capacity (
  rev BIGINT NOT NULL REFERENCES planner_state_snapshots(rev) ON DELETE CASCADE,
  process_code TEXT NOT NULL,
  minutes NUMERIC NOT NULL,
  PRIMARY KEY (rev, process_code)
);

CREATE TABLE planner_state_parallel (
  rev BIGINT NOT NULL REFERENCES planner_state_snapshots(rev) ON DELETE CASCADE,
  process_code TEXT NOT NULL,
  is_parallel BOOLEAN NOT NULL,
  PRIMARY KEY (rev, process_code)
);

CREATE TABLE planner_state_route_overrides (
  rev BIGINT NOT NULL REFERENCES planner_state_snapshots(rev) ON DELETE CASCADE,
  parent_order_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  source TEXT,
  PRIMARY KEY (rev, parent_order_id, stage)
);

CREATE TABLE planner_state_ignored_states (
  rev BIGINT NOT NULL REFERENCES planner_state_snapshots(rev) ON DELETE CASCADE,
  state_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (rev, state_key)
);

CREATE TABLE planner_state_list_entries (
  id BIGSERIAL PRIMARY KEY,
  rev BIGINT NOT NULL REFERENCES planner_state_snapshots(rev) ON DELETE CASCADE,
  list_key TEXT NOT NULL,
  parent_order_id TEXT,
  child_order_id TEXT,
  order_identity TEXT,
  ordinal INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX planner_state_list_entries_rev_list_idx
  ON planner_state_list_entries (rev, list_key, ordinal);

CREATE TABLE planner_state_list_entry_attributes (
  entry_id BIGINT NOT NULL REFERENCES planner_state_list_entries(id) ON DELETE CASCADE,
  attr_path TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  value_type TEXT NOT NULL,
  value_text TEXT,
  value_numeric NUMERIC,
  value_boolean BOOLEAN,
  value_timestamp TIMESTAMPTZ,
  PRIMARY KEY (entry_id, attr_path, ordinal)
);

CREATE TABLE planner_meta_values (
  rev BIGINT NOT NULL REFERENCES planner_state_snapshots(rev) ON DELETE CASCADE,
  path TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  value_type TEXT NOT NULL,
  value_text TEXT,
  value_numeric NUMERIC,
  value_boolean BOOLEAN,
  value_timestamp TIMESTAMPTZ,
  PRIMARY KEY (rev, path, ordinal)
);

CREATE TABLE planner_meta_history_entries (
  id BIGSERIAL PRIMARY KEY,
  rev BIGINT NOT NULL REFERENCES planner_state_snapshots(rev) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  actor TEXT,
  source TEXT,
  note TEXT,
  summary TEXT,
  event_time TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX planner_meta_history_entries_rev_idx
  ON planner_meta_history_entries (rev, ordinal);

CREATE TABLE planner_meta_history_entry_attributes (
  entry_id BIGINT NOT NULL REFERENCES planner_meta_history_entries(id) ON DELETE CASCADE,
  attr_path TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  value_type TEXT NOT NULL,
  value_text TEXT,
  value_numeric NUMERIC,
  value_boolean BOOLEAN,
  value_timestamp TIMESTAMPTZ,
  PRIMARY KEY (entry_id, attr_path, ordinal)
);

CREATE TABLE planner_state_crm_values (
  rev BIGINT NOT NULL REFERENCES planner_state_snapshots(rev) ON DELETE CASCADE,
  path TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  value_type TEXT NOT NULL,
  value_text TEXT,
  value_numeric NUMERIC,
  value_boolean BOOLEAN,
  value_timestamp TIMESTAMPTZ,
  PRIMARY KEY (rev, path, ordinal)
);

CREATE TABLE planner_state_mode_scoped_values (
  rev BIGINT NOT NULL REFERENCES planner_state_snapshots(rev) ON DELETE CASCADE,
  path TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  value_type TEXT NOT NULL,
  value_text TEXT,
  value_numeric NUMERIC,
  value_boolean BOOLEAN,
  value_timestamp TIMESTAMPTZ,
  PRIMARY KEY (rev, path, ordinal)
);

CREATE TABLE planner_settings (
  path TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  value_type TEXT NOT NULL,
  value_text TEXT,
  value_numeric NUMERIC,
  value_boolean BOOLEAN,
  value_timestamp TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT,
  PRIMARY KEY (path, ordinal)
);

CREATE TABLE planner_preferences (
  key TEXT PRIMARY KEY,
  value BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT
);

COMMIT;
