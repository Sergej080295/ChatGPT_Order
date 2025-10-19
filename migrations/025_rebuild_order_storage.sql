BEGIN;

-- Ensure base snapshot table exists so foreign keys remain valid.
CREATE TABLE IF NOT EXISTS planner_state_snapshots (
  rev BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  creator TEXT
);

-- Prepare new consolidated tables for orders and peredels (stages).
CREATE TABLE IF NOT EXISTS planner_orders (
  id BIGSERIAL PRIMARY KEY,
  rev BIGINT NOT NULL REFERENCES planner_state_snapshots(rev) ON DELETE CASCADE,
  parent_order_id TEXT NOT NULL,
  order_identity TEXT,
  crm_order_id TEXT,
  order_number TEXT,
  order_customer TEXT,
  order_title TEXT,
  status TEXT,
  state TEXT,
  progress NUMERIC(10,4),
  percent NUMERIC(10,4),
  total_hours NUMERIC(12,4),
  extra_hours NUMERIC(12,4),
  remaining_hours NUMERIC(12,4),
  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  orig_start_at TIMESTAMPTZ,
  done_at TIMESTAMPTZ,
  done_source TEXT,
  use_reserve BOOLEAN,
  locked BOOLEAN,
  list_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rev, parent_order_id)
);

CREATE INDEX IF NOT EXISTS planner_orders_rev_list_idx
  ON planner_orders (rev, list_key, ordinal);

CREATE INDEX IF NOT EXISTS planner_orders_parent_idx
  ON planner_orders (parent_order_id);

CREATE TABLE IF NOT EXISTS planner_order_stages (
  id BIGSERIAL PRIMARY KEY,
  rev BIGINT NOT NULL REFERENCES planner_state_snapshots(rev) ON DELETE CASCADE,
  order_id BIGINT NOT NULL REFERENCES planner_orders(id) ON DELETE CASCADE,
  parent_order_id TEXT NOT NULL,
  child_order_id TEXT NOT NULL,
  order_identity TEXT,
  crm_child_id TEXT,
  stage TEXT,
  status TEXT,
  state TEXT,
  progress NUMERIC(10,4),
  percent NUMERIC(10,4),
  hours NUMERIC(12,4),
  extra_hours NUMERIC(12,4),
  remaining_hours NUMERIC(12,4),
  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  orig_start_at TIMESTAMPTZ,
  done_at TIMESTAMPTZ,
  done_source TEXT,
  use_reserve BOOLEAN,
  locked BOOLEAN,
  list_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rev, parent_order_id, child_order_id)
);

CREATE INDEX IF NOT EXISTS planner_order_stages_rev_list_idx
  ON planner_order_stages (rev, list_key, ordinal);

CREATE INDEX IF NOT EXISTS planner_order_stages_parent_idx
  ON planner_order_stages (parent_order_id);

-- Attribute storage keeps auxiliary values that are not mapped to dedicated columns yet.
CREATE TABLE IF NOT EXISTS planner_order_stage_attributes (
  stage_id BIGINT NOT NULL REFERENCES planner_order_stages(id) ON DELETE CASCADE,
  attr_path TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  value_type TEXT NOT NULL,
  value_text TEXT,
  value_numeric NUMERIC(20,6),
  value_boolean BOOLEAN,
  value_timestamp TIMESTAMPTZ,
  PRIMARY KEY (stage_id, attr_path, ordinal)
);

-- Route segments per stage (optional detailed schedule for each peredel).
CREATE TABLE IF NOT EXISTS planner_order_stage_routes (
  stage_id BIGINT NOT NULL REFERENCES planner_order_stages(id) ON DELETE CASCADE,
  segment_key TEXT NOT NULL,
  hours NUMERIC(12,4),
  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  orig_start_at TIMESTAMPTZ,
  done_at TIMESTAMPTZ,
  PRIMARY KEY (stage_id, segment_key)
);

-- Backfill from the legacy tables if they still exist.
DO $$
DECLARE
  legacy_orders regclass := 'planner_state_orders'::regclass;
  legacy_attrs regclass := 'planner_state_order_attributes'::regclass;
  legacy_routes regclass := 'planner_state_order_routes'::regclass;
BEGIN
  IF legacy_orders IS NOT NULL THEN
    WITH latest_order AS (
      SELECT *,
             COALESCE(
               parent_order_id,
               order_identity,
               order_number,
               crm_order_id,
               'legacy_parent_' || id::text
             ) AS normalized_parent_id,
             ROW_NUMBER() OVER (
               PARTITION BY rev,
               COALESCE(
                 parent_order_id,
                 order_identity,
                 order_number,
                 crm_order_id,
                 'legacy_parent_' || id::text
               )
               ORDER BY ordinal ASC, id DESC
             ) AS row_rank
        FROM planner_state_orders
    ),
    inserted_orders AS (
      INSERT INTO planner_orders (
        rev, parent_order_id, order_identity, crm_order_id, order_number,
        order_customer, order_title, status, state, progress, percent,
        total_hours, extra_hours, remaining_hours, start_at, end_at,
        orig_start_at, done_at, done_source, use_reserve, locked,
        list_key, ordinal, updated_at
      )
      SELECT lo.rev,
             lo.normalized_parent_id,
             lo.order_identity,
             lo.crm_order_id,
             lo.order_number,
             lo.order_customer,
             lo.order_title,
             lo.status,
             lo.state,
             lo.progress,
             NULL,
             lo.hours,
             lo.extra_hours,
             NULL,
             lo.start_at,
             lo.end_at,
             lo.orig_start_at,
             lo.done_at,
             lo.done_source,
             lo.use_reserve,
             lo.locked,
             lo.list_key,
             lo.ordinal,
             now()
        FROM latest_order lo
       WHERE lo.row_rank = 1
       RETURNING id, rev, parent_order_id
    )
    INSERT INTO planner_order_stages (
      rev, order_id, parent_order_id, child_order_id, order_identity, crm_child_id,
      stage, status, state, progress, percent, hours, extra_hours, remaining_hours,
      start_at, end_at, orig_start_at, done_at, done_source, use_reserve,
      locked, list_key, ordinal, updated_at
    )
    SELECT o.rev,
           io.id,
           COALESCE(
             o.parent_order_id,
             o.order_identity,
             o.order_number,
             o.crm_order_id,
             'legacy_parent_' || o.id::text
           ),
           COALESCE(
             o.child_order_id,
             o.uid,
             o.order_identity,
             o.order_number,
             o.crm_child_id,
             'legacy_child_' || o.id::text
           ),
           o.order_identity,
           o.crm_child_id,
           o.stage,
           o.status,
           o.state,
           o.progress,
           NULL,
           o.hours,
           o.extra_hours,
           NULL,
           o.start_at,
           o.end_at,
           o.orig_start_at,
           o.done_at,
           o.done_source,
           o.use_reserve,
           o.locked,
           o.list_key,
           o.ordinal,
           now()
      FROM planner_state_orders o
      JOIN inserted_orders io
        ON io.rev = o.rev
       AND io.parent_order_id = COALESCE(
         o.parent_order_id,
         o.order_identity,
         o.order_number,
         o.crm_order_id,
         'legacy_parent_' || o.id::text
       );

    IF legacy_attrs IS NOT NULL THEN
      INSERT INTO planner_order_stage_attributes (
        stage_id, attr_path, ordinal, value_type, value_text, value_numeric,
        value_boolean, value_timestamp
      )
      SELECT ps.id,
             a.attr_path,
             a.ordinal,
             a.value_type,
             a.value_text,
             a.value_numeric,
             a.value_boolean,
             NULL
        FROM planner_state_order_attributes a
        JOIN planner_state_orders so ON so.id = a.order_id
        JOIN planner_order_stages ps
          ON ps.rev = so.rev
         AND ps.parent_order_id = COALESCE(
           so.parent_order_id,
           so.order_identity,
           so.order_number,
           so.crm_order_id,
           'legacy_parent_' || so.id::text
         )
         AND COALESCE(
           ps.child_order_id,
           ps.order_identity,
           ps.crm_child_id
         ) = COALESCE(
           so.child_order_id,
           so.uid,
           so.order_identity,
           so.order_number,
           so.crm_child_id,
           'legacy_child_' || so.id::text
         )
         AND ps.ordinal = so.ordinal;
    END IF;

    IF legacy_routes IS NOT NULL THEN
      INSERT INTO planner_order_stage_routes (
        stage_id, segment_key, hours, start_at, end_at, orig_start_at, done_at
      )
      SELECT ps.id,
             r.segment_key,
             r.hours,
             r.start_at,
             r.end_at,
             r.orig_start_at,
             r.done_at
        FROM planner_state_order_routes r
        JOIN planner_state_orders so ON so.id = r.order_id
        JOIN planner_order_stages ps
          ON ps.rev = so.rev
         AND ps.parent_order_id = COALESCE(
           so.parent_order_id,
           so.order_identity,
           so.order_number,
           so.crm_order_id,
           'legacy_parent_' || so.id::text
         )
         AND COALESCE(
           ps.child_order_id,
           ps.order_identity,
           ps.crm_child_id
         ) = COALESCE(
           so.child_order_id,
           so.uid,
           so.order_identity,
           so.order_number,
           so.crm_child_id,
           'legacy_child_' || so.id::text
         )
         AND ps.ordinal = so.ordinal;
    END IF;

    DROP TABLE IF EXISTS planner_state_order_routes;
    DROP TABLE IF EXISTS planner_state_order_attributes;
    DROP TABLE IF EXISTS planner_state_orders;
  END IF;
END$$;

COMMIT;
