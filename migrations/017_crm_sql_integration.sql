BEGIN;

/* Ensure CRM boards table exists with the expected structure. */
CREATE TABLE IF NOT EXISTS crm_boards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  lanes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  position INTEGER NOT NULL DEFAULT 0,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

/* Create the CRM orders table if it has not been provisioned yet. */
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
  child_ids TEXT[] DEFAULT ARRAY[]::TEXT[],
  parent_id TEXT
);

ALTER TABLE crm_boards
  ADD COLUMN IF NOT EXISTS id TEXT,
  ADD COLUMN IF NOT EXISTS name TEXT,
  ADD COLUMN IF NOT EXISTS lanes TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS position INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payload JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

/* Ensure CRM state is present before any cleanup. */
CREATE TABLE IF NOT EXISTS crm_state (
  id SMALLINT PRIMARY KEY DEFAULT 1,
  current_board_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  meta JSONB NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE crm_orders
  ADD COLUMN IF NOT EXISTS id TEXT,
  ADD COLUMN IF NOT EXISTS board_id TEXT,
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS position INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payload JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS order_no TEXT,
  ADD COLUMN IF NOT EXISTS customer TEXT,
  ADD COLUMN IF NOT EXISTS done BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS service_total NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS start_date DATE,
  ADD COLUMN IF NOT EXISTS end_date DATE,
  ADD COLUMN IF NOT EXISTS priority INTEGER,
  ADD COLUMN IF NOT EXISTS child_ids TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS parent_id TEXT;

/*
  Legacy data becomes stale once CRM is sourced from shared SQL snapshot.
  Clean the tables so the planner can repopulate them on the next save.
*/
DELETE FROM crm_orders;
DELETE FROM crm_boards;
DELETE FROM crm_state;

ALTER TABLE crm_orders DROP COLUMN IF EXISTS progress;
ALTER TABLE crm_orders ADD COLUMN progress SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE crm_boards ALTER COLUMN lanes SET DEFAULT ARRAY[]::TEXT[];
ALTER TABLE crm_boards ALTER COLUMN lanes SET NOT NULL;
ALTER TABLE crm_boards ALTER COLUMN name SET NOT NULL;
ALTER TABLE crm_boards ALTER COLUMN position SET DEFAULT 0;
ALTER TABLE crm_boards ALTER COLUMN position SET NOT NULL;
ALTER TABLE crm_boards ALTER COLUMN payload SET DEFAULT '{}'::jsonb;
ALTER TABLE crm_boards ALTER COLUMN payload SET NOT NULL;
ALTER TABLE crm_boards ALTER COLUMN updated_at SET DEFAULT NOW();
ALTER TABLE crm_boards ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE crm_boards
  DROP CONSTRAINT IF EXISTS crm_boards_pkey;

ALTER TABLE crm_boards
  ADD CONSTRAINT crm_boards_pkey PRIMARY KEY (id);

CREATE INDEX IF NOT EXISTS crm_boards_position_idx ON crm_boards(position);

ALTER TABLE crm_orders ALTER COLUMN position SET DEFAULT 0;
ALTER TABLE crm_orders ALTER COLUMN position SET NOT NULL;
ALTER TABLE crm_orders ALTER COLUMN payload SET DEFAULT '{}'::jsonb;
ALTER TABLE crm_orders ALTER COLUMN payload SET NOT NULL;
ALTER TABLE crm_orders ALTER COLUMN updated_at SET DEFAULT NOW();
ALTER TABLE crm_orders ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE crm_orders ALTER COLUMN created_at SET DEFAULT NOW();
ALTER TABLE crm_orders ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE crm_orders ALTER COLUMN done SET DEFAULT FALSE;
ALTER TABLE crm_orders ALTER COLUMN done SET NOT NULL;
ALTER TABLE crm_orders ALTER COLUMN child_ids SET DEFAULT ARRAY[]::TEXT[];
ALTER TABLE crm_orders ALTER COLUMN board_id SET NOT NULL;
ALTER TABLE crm_orders ALTER COLUMN title SET NOT NULL;

ALTER TABLE crm_orders
  DROP CONSTRAINT IF EXISTS crm_orders_pkey;

ALTER TABLE crm_orders
  ADD CONSTRAINT crm_orders_pkey PRIMARY KEY (id);

ALTER TABLE crm_orders
  DROP CONSTRAINT IF EXISTS crm_orders_board_id_fkey;

ALTER TABLE crm_orders
  ADD CONSTRAINT crm_orders_board_id_fkey
    FOREIGN KEY (board_id) REFERENCES crm_boards(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS crm_orders_board_position_idx ON crm_orders(board_id, position);
CREATE INDEX IF NOT EXISTS crm_orders_status_idx ON crm_orders(status);

ALTER TABLE crm_state
  ADD COLUMN IF NOT EXISTS id SMALLINT DEFAULT 1,
  ADD COLUMN IF NOT EXISTS current_board_id TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS meta JSONB DEFAULT '{}'::jsonb;

ALTER TABLE crm_state
  ALTER COLUMN id SET DEFAULT 1,
  ALTER COLUMN updated_at SET DEFAULT NOW(),
  ALTER COLUMN updated_at SET NOT NULL,
  ALTER COLUMN meta SET DEFAULT '{}'::jsonb,
  ALTER COLUMN meta SET NOT NULL;

ALTER TABLE crm_state
  DROP CONSTRAINT IF EXISTS crm_state_pkey;

ALTER TABLE crm_state
  ADD CONSTRAINT crm_state_pkey PRIMARY KEY (id);

COMMIT;
