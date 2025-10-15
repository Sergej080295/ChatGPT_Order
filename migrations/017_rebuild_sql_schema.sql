BEGIN;

DROP TABLE IF EXISTS planner_state_history CASCADE;
DROP TABLE IF EXISTS orders_hist CASCADE;
DROP TABLE IF EXISTS order_process_hist CASCADE;
DROP TABLE IF EXISTS capacity_by_process_hist CASCADE;
DROP TABLE IF EXISTS settings_autoweight_hist CASCADE;
DROP TABLE IF EXISTS settings_journal_hist CASCADE;
DROP TABLE IF EXISTS settings_column_widths_hist CASCADE;
DROP TABLE IF EXISTS settings_mapping_hist CASCADE;
DROP TABLE IF EXISTS settings_admin_hist CASCADE;
DROP TABLE IF EXISTS excluded_statuses_hist CASCADE;
DROP TABLE IF EXISTS settings_shared_preferences_hist CASCADE;
DROP TABLE IF EXISTS activity_log CASCADE;
DROP TABLE IF EXISTS order_process CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS customers CASCADE;
DROP TABLE IF EXISTS processes CASCADE;
DROP TABLE IF EXISTS capacity_by_process CASCADE;
DROP TABLE IF EXISTS settings_autoweight CASCADE;
DROP TABLE IF EXISTS settings_journal CASCADE;
DROP TABLE IF EXISTS settings_column_widths CASCADE;
DROP TABLE IF EXISTS settings_mapping CASCADE;
DROP TABLE IF EXISTS settings_admin CASCADE;
DROP TABLE IF EXISTS excluded_statuses CASCADE;
DROP TABLE IF EXISTS settings_shared_preferences CASCADE;
DROP TABLE IF EXISTS planner_state_snapshots CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS revisions CASCADE;

DROP SEQUENCE IF EXISTS revisions_rev_seq CASCADE;

CREATE SEQUENCE revisions_rev_seq;

CREATE TABLE revisions (
  rev BIGINT PRIMARY KEY DEFAULT nextval('revisions_rev_seq'),
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor TEXT,
  source TEXT,
  note TEXT
);

ALTER SEQUENCE revisions_rev_seq OWNED BY revisions.rev;

CREATE TABLE state_snapshots (
  id BIGSERIAL PRIMARY KEY,
  rev BIGINT NOT NULL UNIQUE REFERENCES revisions(rev) ON DELETE CASCADE,
  state_text TEXT NOT NULL,
  meta_text TEXT,
  hash TEXT NOT NULL,
  actor TEXT,
  source TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX state_snapshots_created_idx ON state_snapshots(created_at DESC);

CREATE TABLE processes (
  id SMALLSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  position SMALLINT NOT NULL DEFAULT 0,
  has_hours BOOLEAN NOT NULL DEFAULT TRUE,
  is_parallel BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE customers (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  crm_id TEXT UNIQUE
);

CREATE TABLE orders (
  id BIGSERIAL PRIMARY KEY,
  crm_order_id TEXT,
  number TEXT NOT NULL,
  order_no TEXT,
  customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  status TEXT,
  title TEXT,
  client TEXT,
  priority INTEGER,
  due_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX orders_status_idx ON orders(status);
CREATE INDEX orders_active_idx ON orders(id) WHERE deleted_at IS NULL;

CREATE TABLE order_process (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  process_id SMALLINT NOT NULL REFERENCES processes(id) ON DELETE RESTRICT,
  seq SMALLINT NOT NULL DEFAULT 0,
  planned_start TIMESTAMPTZ,
  planned_end TIMESTAMPTZ,
  actual_start TIMESTAMPTZ,
  actual_end TIMESTAMPTZ,
  progress SMALLINT NOT NULL DEFAULT 0,
  is_done BOOLEAN NOT NULL DEFAULT FALSE,
  position_index INTEGER,
  hidden_by_state BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX order_process_process_position_idx ON order_process(process_id, position_index);
CREATE INDEX order_process_order_seq_idx ON order_process(order_id, seq);

CREATE TABLE capacity_by_process (
  process_id SMALLINT NOT NULL REFERENCES processes(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  minutes INTEGER NOT NULL,
  PRIMARY KEY (process_id, day)
);

CREATE TABLE activity_log (
  id BIGSERIAL PRIMARY KEY,
  rev BIGINT REFERENCES revisions(rev) ON DELETE SET NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor TEXT,
  source TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id BIGINT,
  details TEXT
);

CREATE INDEX activity_log_rev_idx ON activity_log(rev);

CREATE TABLE settings_values (
  key TEXT PRIMARY KEY,
  value_text TEXT,
  value_number NUMERIC,
  value_boolean BOOLEAN,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE settings_column_widths (
  column_key TEXT PRIMARY KEY,
  width_px INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE settings_stage_mapping (
  crm_stage TEXT PRIMARY KEY,
  planner_process_id SMALLINT REFERENCES processes(id) ON DELETE SET NULL,
  is_ignored BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE excluded_statuses (
  status_key TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE settings_shared_preferences (
  pref_key TEXT PRIMARY KEY,
  bool_value BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
