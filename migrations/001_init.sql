BEGIN;

CREATE TABLE IF NOT EXISTS planner_schema_migrations (
  id SERIAL PRIMARY KEY,
  filename TEXT UNIQUE NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stage_type (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_order (
  id BIGSERIAL PRIMARY KEY,
  order_no TEXT NOT NULL,
  title TEXT,
  client TEXT,
  priority INTEGER,
  due_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (order_no, is_deleted)
);

CREATE TABLE IF NOT EXISTS order_stage (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES customer_order(id) ON DELETE CASCADE,
  stage_type_id INTEGER NOT NULL REFERENCES stage_type(id) ON DELETE RESTRICT,
  external_uid TEXT UNIQUE,
  hours NUMERIC(12,2),
  extra_hours NUMERIC(12,2),
  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  start_missing BOOLEAN DEFAULT FALSE,
  end_missing BOOLEAN DEFAULT FALSE,
  state TEXT,
  status TEXT,
  progress NUMERIC(5,2),
  use_reserve BOOLEAN DEFAULT FALSE,
  orig_start_at TIMESTAMPTZ,
  version INTEGER DEFAULT 1,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS order_stage_order_idx ON order_stage(order_id);
CREATE INDEX IF NOT EXISTS order_stage_stage_start_idx ON order_stage(stage_type_id, start_at);
CREATE INDEX IF NOT EXISTS order_stage_active_idx ON order_stage(stage_type_id, start_at)
  WHERE is_deleted = FALSE AND (status IS NULL OR status IN ('Выполняется', 'Ожидает'));

CREATE TABLE IF NOT EXISTS stage_completion (
  id BIGSERIAL PRIMARY KEY,
  order_stage_id BIGINT REFERENCES order_stage(id) ON DELETE CASCADE,
  completed_at TIMESTAMPTZ NOT NULL,
  source TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stage_exception (
  id BIGSERIAL PRIMARY KEY,
  order_stage_id BIGINT REFERENCES order_stage(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS capacity_by_stage (
  stage_type_id INTEGER PRIMARY KEY REFERENCES stage_type(id) ON DELETE CASCADE,
  capacity_per_day NUMERIC(12,2) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS parallel_limits (
  code TEXT PRIMARY KEY,
  max_parallel INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS planner_settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  autosave_on BOOLEAN,
  auto_optimize_on BOOLEAN,
  shift_on_progress BOOLEAN,
  storage_mode TEXT,
  extra JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS planner_state (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  state TEXT NOT NULL,
  meta JSONB,
  hash TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS planner_activity_log (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stage TEXT,
  version INTEGER,
  user_name TEXT,
  session TEXT,
  source TEXT,
  summary TEXT,
  diff JSONB,
  orders_summary JSONB,
  ip TEXT
);

CREATE INDEX IF NOT EXISTS planner_activity_log_timestamp_idx ON planner_activity_log (timestamp);
CREATE INDEX IF NOT EXISTS planner_activity_log_stage_idx ON planner_activity_log (stage);

COMMIT;
