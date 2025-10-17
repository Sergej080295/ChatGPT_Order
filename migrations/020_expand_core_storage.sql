BEGIN;

ALTER TABLE pc_orders
  ADD COLUMN IF NOT EXISTS crm_order_id TEXT,
  ADD COLUMN IF NOT EXISTS order_number TEXT,
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS customer TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS priority TEXT,
  ADD COLUMN IF NOT EXISTS due_date TEXT,
  ADD COLUMN IF NOT EXISTS planned_start TEXT,
  ADD COLUMN IF NOT EXISTS planned_finish TEXT,
  ADD COLUMN IF NOT EXISTS ready_percent NUMERIC,
  ADD COLUMN IF NOT EXISTS manager TEXT,
  ADD COLUMN IF NOT EXISTS updated_by TEXT,
  ADD COLUMN IF NOT EXISTS updated_text TEXT;

ALTER TABLE pc_order_tasks
  ADD COLUMN IF NOT EXISTS crm_order_id TEXT,
  ADD COLUMN IF NOT EXISTS order_number TEXT,
  ADD COLUMN IF NOT EXISTS stage_name TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS priority TEXT,
  ADD COLUMN IF NOT EXISTS executor TEXT,
  ADD COLUMN IF NOT EXISTS planned_start TEXT,
  ADD COLUMN IF NOT EXISTS planned_finish TEXT,
  ADD COLUMN IF NOT EXISTS actual_start TEXT,
  ADD COLUMN IF NOT EXISTS actual_finish TEXT,
  ADD COLUMN IF NOT EXISTS due_date TEXT,
  ADD COLUMN IF NOT EXISTS expected_percent NUMERIC,
  ADD COLUMN IF NOT EXISTS progress_percent NUMERIC;

CREATE INDEX IF NOT EXISTS pc_orders_crm_order_idx ON pc_orders(crm_order_id);
CREATE INDEX IF NOT EXISTS pc_orders_number_idx ON pc_orders(order_number);
CREATE INDEX IF NOT EXISTS pc_order_tasks_stage_idx ON pc_order_tasks(stage_code);
CREATE INDEX IF NOT EXISTS pc_order_tasks_crm_idx ON pc_order_tasks(crm_order_id);

COMMIT;
