BEGIN;

-- Ensure the core snapshot table exists even if earlier migrations were partially applied.
CREATE TABLE IF NOT EXISTS planner_state_snapshots (
  rev BIGINT PRIMARY KEY REFERENCES revisions(rev) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS planner_state_orders (
  id BIGSERIAL PRIMARY KEY,
  rev BIGINT NOT NULL REFERENCES planner_state_snapshots(rev) ON DELETE CASCADE,
  list_key TEXT NOT NULL,
  parent_order_id TEXT,
  child_order_id TEXT,
  order_identity TEXT,
  crm_order_id TEXT,
  crm_child_id TEXT,
  ordinal INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS planner_state_orders_rev_list_idx
  ON planner_state_orders (rev, list_key, ordinal);

CREATE TABLE IF NOT EXISTS planner_state_order_attributes (
  order_id BIGINT NOT NULL REFERENCES planner_state_orders(id) ON DELETE CASCADE,
  attr_path TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  value_type TEXT NOT NULL,
  value_text TEXT,
  value_numeric NUMERIC,
  value_boolean BOOLEAN,
  value_timestamp TIMESTAMPTZ,
  PRIMARY KEY (order_id, attr_path, ordinal)
);

WITH source_entries AS (
  SELECT id AS entry_id,
         rev,
         list_key,
         parent_order_id,
         child_order_id,
         order_identity,
         ordinal
    FROM planner_state_list_entries
   WHERE list_key IN ('t', 'done', 'trash')
),
inserted_orders AS (
  INSERT INTO planner_state_orders (rev, list_key, parent_order_id, child_order_id, order_identity, ordinal)
  SELECT rev, list_key, parent_order_id, child_order_id, order_identity, ordinal
    FROM source_entries
  RETURNING id,
            rev,
            list_key,
            parent_order_id,
            child_order_id,
            order_identity,
            ordinal
)
INSERT INTO planner_state_order_attributes (order_id, attr_path, ordinal, value_type, value_text, value_numeric, value_boolean, value_timestamp)
SELECT ins.id,
       attrs.attr_path,
       attrs.ordinal,
       attrs.value_type,
       attrs.value_text,
       attrs.value_numeric,
       attrs.value_boolean,
       attrs.value_timestamp
  FROM planner_state_list_entry_attributes AS attrs
  JOIN planner_state_list_entries AS entries
    ON entries.id = attrs.entry_id
  JOIN inserted_orders AS ins
    ON ins.rev = entries.rev
   AND ins.list_key = entries.list_key
   AND ins.ordinal = entries.ordinal
   AND (ins.parent_order_id IS NOT DISTINCT FROM entries.parent_order_id)
   AND (ins.child_order_id IS NOT DISTINCT FROM entries.child_order_id)
   AND (ins.order_identity IS NOT DISTINCT FROM entries.order_identity)
 WHERE entries.list_key IN ('t', 'done', 'trash');

DELETE FROM planner_state_list_entries
 WHERE list_key IN ('t', 'done', 'trash');

COMMIT;
