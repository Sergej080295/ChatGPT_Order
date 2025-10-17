BEGIN;

-- Drop legacy snapshot storage if present.
DROP TABLE IF EXISTS planner_state_snapshots CASCADE;

-- Remove snapshot-specific columns from settings_admin.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'settings_admin'
       AND column_name = 'snapshot_retention'
  ) THEN
    ALTER TABLE settings_admin DROP COLUMN snapshot_retention;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'settings_admin'
       AND column_name = 'history_limit'
  ) THEN
    ALTER TABLE settings_admin DROP COLUMN history_limit;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'settings_admin'
       AND column_name = 'history_daily_limit'
  ) THEN
    ALTER TABLE settings_admin DROP COLUMN history_daily_limit;
  END IF;
END;
$$;

-- Ensure allow_force_overwrite and write_mode columns exist for backwards compatibility.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'settings_admin'
       AND column_name = 'allow_force_overwrite'
  ) THEN
    ALTER TABLE settings_admin ADD COLUMN allow_force_overwrite BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'settings_admin'
       AND column_name = 'write_mode'
  ) THEN
    ALTER TABLE settings_admin ADD COLUMN write_mode TEXT NOT NULL DEFAULT 'both';
  END IF;
END;
$$;

-- Tables for CRM metadata and planner payloads.
CREATE TABLE IF NOT EXISTS crm_boards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  lanes TEXT[] NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS crm_orders_meta (
  order_key TEXT PRIMARY KEY,
  order_id BIGINT REFERENCES orders(id) ON DELETE CASCADE,
  board_id TEXT,
  crm_order_id TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS crm_orders_meta_board_idx ON crm_orders_meta(board_id, position);

CREATE TABLE IF NOT EXISTS planner_tasks_payload (
  uid TEXT PRIMARY KEY,
  order_key TEXT,
  stage_code TEXT,
  is_done BOOLEAN NOT NULL DEFAULT FALSE,
  sort_index INTEGER NOT NULL DEFAULT 0,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS planner_tasks_stage_idx ON planner_tasks_payload(stage_code, is_done, sort_index);

CREATE TABLE IF NOT EXISTS planner_stage_orders (
  stage_code TEXT PRIMARY KEY,
  order_uids TEXT[] NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS planner_misc_state (
  key TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
