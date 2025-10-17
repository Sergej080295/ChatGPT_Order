BEGIN;

ALTER TABLE planner_state_orders
  ADD COLUMN IF NOT EXISTS uid TEXT,
  ADD COLUMN IF NOT EXISTS order_number TEXT,
  ADD COLUMN IF NOT EXISTS order_customer TEXT,
  ADD COLUMN IF NOT EXISTS order_title TEXT,
  ADD COLUMN IF NOT EXISTS stage TEXT,
  ADD COLUMN IF NOT EXISTS state TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS hours NUMERIC,
  ADD COLUMN IF NOT EXISTS extra_hours NUMERIC,
  ADD COLUMN IF NOT EXISTS start_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS end_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS orig_start_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS done_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS done_source TEXT,
  ADD COLUMN IF NOT EXISTS progress NUMERIC,
  ADD COLUMN IF NOT EXISTS use_reserve BOOLEAN,
  ADD COLUMN IF NOT EXISTS locked BOOLEAN;

CREATE TABLE IF NOT EXISTS planner_state_order_routes (
  order_id BIGINT NOT NULL REFERENCES planner_state_orders(id) ON DELETE CASCADE,
  segment_key TEXT NOT NULL,
  hours NUMERIC,
  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  orig_start_at TIMESTAMPTZ,
  done_at TIMESTAMPTZ,
  PRIMARY KEY (order_id, segment_key)
);

CREATE INDEX IF NOT EXISTS planner_state_orders_rev_uid_idx
  ON planner_state_orders (rev, uid);
CREATE INDEX IF NOT EXISTS planner_state_orders_rev_order_identity_idx
  ON planner_state_orders (rev, order_identity);

WITH attr_values AS (
  SELECT
    order_id,
    MAX(CASE WHEN attr_path = 'uid' THEN value_text END) AS uid,
    MAX(CASE WHEN attr_path IN ('childId','child_id') THEN value_text END) AS child_id,
    MAX(CASE WHEN attr_path IN ('orderNumber','order_number','orderNo') THEN value_text END) AS order_number,
    MAX(CASE WHEN attr_path IN ('orderCustomer','customer') THEN value_text END) AS order_customer,
    MAX(CASE WHEN attr_path IN ('orderTitle','title','name') THEN value_text END) AS order_title,
    MAX(CASE WHEN attr_path = 'stage' THEN value_text END) AS stage,
    MAX(CASE WHEN attr_path = 'state' THEN value_text END) AS state,
    MAX(CASE WHEN attr_path = 'status' THEN value_text END) AS status,
    MAX(CASE WHEN attr_path = 'hours' THEN value_numeric END) AS hours,
    MAX(CASE WHEN attr_path IN ('extraHours','extra') THEN value_numeric END) AS extra_hours,
    MAX(CASE WHEN attr_path IN ('startDate','start') AND value_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN value_text::timestamptz END) AS start_at,
    MAX(CASE WHEN attr_path IN ('endDate','end') AND value_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN value_text::timestamptz END) AS end_at,
    MAX(CASE WHEN attr_path IN ('origStartDate','origStart','originalStart') AND value_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN value_text::timestamptz END) AS orig_start_at,
    MAX(CASE WHEN attr_path IN ('doneMeta/when','doneAt','when') AND value_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN value_text::timestamptz END) AS done_at,
    MAX(CASE WHEN attr_path IN ('doneMeta/source','source') THEN value_text END) AS done_source,
    MAX(CASE WHEN attr_path = 'progress' AND value_numeric IS NOT NULL THEN value_numeric END) AS progress_numeric,
    MAX(CASE WHEN attr_path = 'progress' AND value_numeric IS NULL AND value_text ~ '^-?\\d+(?:\\.\\d+)?$' THEN value_text::numeric END) AS progress_text_numeric,
    MAX(CASE WHEN attr_path = 'useReserve' THEN value_boolean END) AS use_reserve_bool,
    MAX(CASE WHEN attr_path = 'locked' THEN value_boolean END) AS locked_bool
  FROM planner_state_order_attributes
  GROUP BY order_id
)
UPDATE planner_state_orders AS o
SET uid = COALESCE(o.uid, attr.uid, attr.child_id, o.child_order_id),
    order_number = COALESCE(o.order_number, attr.order_number),
    order_customer = COALESCE(o.order_customer, attr.order_customer),
    order_title = COALESCE(o.order_title, attr.order_title, o.order_identity),
    stage = COALESCE(o.stage, attr.stage),
    state = COALESCE(o.state, attr.state),
    status = COALESCE(o.status, attr.status),
    hours = COALESCE(o.hours, attr.hours),
    extra_hours = COALESCE(o.extra_hours, attr.extra_hours),
    start_at = COALESCE(o.start_at, attr.start_at),
    end_at = COALESCE(o.end_at, attr.end_at),
    orig_start_at = COALESCE(o.orig_start_at, attr.orig_start_at),
    done_at = COALESCE(o.done_at, attr.done_at),
    done_source = COALESCE(o.done_source, NULLIF(attr.done_source, '')),
    progress = COALESCE(o.progress, attr.progress_numeric, attr.progress_text_numeric),
    use_reserve = COALESCE(o.use_reserve, attr.use_reserve_bool),
    locked = COALESCE(o.locked, attr.locked_bool)
FROM attr_values AS attr
WHERE attr.order_id = o.id;

WITH route_attrs AS (
  SELECT
    order_id,
    split_part(attr_path, '/', 2) AS segment_key,
    MAX(CASE WHEN split_part(attr_path, '/', 3) = 'hours' THEN value_numeric END) AS hours,
    MAX(CASE WHEN split_part(attr_path, '/', 3) = 'start' AND value_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN value_text::timestamptz END) AS start_at,
    MAX(CASE WHEN split_part(attr_path, '/', 3) = 'end' AND value_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN value_text::timestamptz END) AS end_at,
    MAX(CASE WHEN split_part(attr_path, '/', 3) IN ('origStart','originalStart') AND value_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN value_text::timestamptz END) AS orig_start_at,
    MAX(CASE WHEN split_part(attr_path, '/', 3) = 'doneAt' AND value_text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN value_text::timestamptz END) AS done_at
  FROM planner_state_order_attributes
  WHERE attr_path LIKE 'route/%/%'
  GROUP BY order_id, split_part(attr_path, '/', 2)
)
INSERT INTO planner_state_order_routes (order_id, segment_key, hours, start_at, end_at, orig_start_at, done_at)
SELECT
  r.order_id,
  r.segment_key,
  r.hours,
  r.start_at,
  r.end_at,
  r.orig_start_at,
  r.done_at
FROM route_attrs AS r
WHERE r.segment_key IS NOT NULL
  AND (r.hours IS NOT NULL OR r.start_at IS NOT NULL OR r.end_at IS NOT NULL OR r.orig_start_at IS NOT NULL OR r.done_at IS NOT NULL)
ON CONFLICT (order_id, segment_key) DO UPDATE
  SET hours = EXCLUDED.hours,
      start_at = EXCLUDED.start_at,
      end_at = EXCLUDED.end_at,
      orig_start_at = EXCLUDED.orig_start_at,
      done_at = EXCLUDED.done_at;

COMMIT;
