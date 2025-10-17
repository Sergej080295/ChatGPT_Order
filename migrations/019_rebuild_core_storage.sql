BEGIN;

-- Drop legacy planner storage tables
DROP TABLE IF EXISTS activity_log CASCADE;
DROP TABLE IF EXISTS planner_stage_orders CASCADE;
DROP TABLE IF EXISTS planner_tasks_payload CASCADE;
DROP TABLE IF EXISTS planner_misc_state CASCADE;
DROP TABLE IF EXISTS crm_orders_meta CASCADE;
DROP TABLE IF EXISTS crm_boards CASCADE;
DROP TABLE IF EXISTS planner_state_snapshots CASCADE;
DROP TABLE IF EXISTS order_process_hist CASCADE;
DROP TABLE IF EXISTS orders_hist CASCADE;
DROP TABLE IF EXISTS order_process CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS customers CASCADE;
DROP TABLE IF EXISTS capacity_by_process_hist CASCADE;
DROP TABLE IF EXISTS capacity_by_process CASCADE;
DROP TABLE IF EXISTS processes CASCADE;
DROP TABLE IF EXISTS revisions CASCADE;
DROP TABLE IF EXISTS settings_admin_hist CASCADE;
DROP TABLE IF EXISTS settings_admin CASCADE;
DROP TABLE IF EXISTS settings_journal_hist CASCADE;
DROP TABLE IF EXISTS settings_journal CASCADE;
DROP TABLE IF EXISTS settings_column_widths_hist CASCADE;
DROP TABLE IF EXISTS settings_column_widths CASCADE;
DROP TABLE IF EXISTS settings_mapping_hist CASCADE;
DROP TABLE IF EXISTS settings_mapping CASCADE;
DROP TABLE IF EXISTS settings_shared_preferences CASCADE;
DROP TABLE IF EXISTS excluded_statuses_hist CASCADE;
DROP TABLE IF EXISTS excluded_statuses CASCADE;
DROP TABLE IF EXISTS settings_autoweight_hist CASCADE;
DROP TABLE IF EXISTS settings_autoweight CASCADE;

-- Create unified storage tables
CREATE TABLE pc_settings (
  key TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE pc_orders (
  uid TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  lane_id TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE pc_order_tasks (
  uid TEXT PRIMARY KEY,
  order_uid TEXT,
  stage_code TEXT,
  bucket TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX pc_order_tasks_bucket_idx ON pc_order_tasks(bucket);
CREATE INDEX pc_order_tasks_order_idx ON pc_order_tasks(order_uid);

CREATE TABLE pc_stage_sequences (
  stage_code TEXT PRIMARY KEY,
  task_uids TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE pc_revisions (
  rev BIGSERIAL PRIMARY KEY,
  hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
