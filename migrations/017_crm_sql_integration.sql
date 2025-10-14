BEGIN;

CREATE TABLE IF NOT EXISTS crm_boards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  lanes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  position INTEGER NOT NULL DEFAULT 0,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS crm_boards_position_idx ON crm_boards(position);

CREATE TABLE IF NOT EXISTS crm_orders (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES crm_boards(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  order_no TEXT,
  customer TEXT,
  progress SMALLINT NOT NULL DEFAULT 0,
  done BOOLEAN NOT NULL DEFAULT FALSE,
  service_total NUMERIC(14,2),
  start_date DATE,
  end_date DATE,
  priority INTEGER,
  child_ids TEXT[],
  parent_id TEXT
);

CREATE INDEX IF NOT EXISTS crm_orders_board_position_idx ON crm_orders(board_id, position);
CREATE INDEX IF NOT EXISTS crm_orders_status_idx ON crm_orders(status);

CREATE TABLE IF NOT EXISTS crm_state (
  id SMALLINT PRIMARY KEY DEFAULT 1,
  current_board_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  meta JSONB NOT NULL DEFAULT '{}'::jsonb
);

COMMIT;
