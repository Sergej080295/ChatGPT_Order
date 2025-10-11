BEGIN;

CREATE SEQUENCE IF NOT EXISTS revisions_rev_seq;

CREATE TABLE IF NOT EXISTS revisions (
  rev BIGINT PRIMARY KEY DEFAULT nextval('revisions_rev_seq'),
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor TEXT,
  source TEXT,
  note TEXT
);

ALTER TABLE revisions
  ADD COLUMN IF NOT EXISTS rev BIGINT,
  ADD COLUMN IF NOT EXISTS ts TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS actor TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS note TEXT;

ALTER TABLE revisions
  ALTER COLUMN ts SET DEFAULT NOW();

ALTER SEQUENCE revisions_rev_seq OWNED BY revisions.rev;

ALTER TABLE revisions
  ALTER COLUMN rev SET DEFAULT nextval('revisions_rev_seq');

UPDATE revisions
  SET ts = NOW()
  WHERE ts IS NULL;

DO $$
DECLARE
  missing_count BIGINT;
BEGIN
  SELECT COUNT(*)
    INTO missing_count
    FROM revisions
   WHERE rev IS NULL;
  IF missing_count > 0 THEN
    UPDATE revisions
       SET rev = nextval('revisions_rev_seq')
     WHERE rev IS NULL;
  END IF;
END;
$$;

DO $$
DECLARE
  max_rev BIGINT;
BEGIN
  SELECT MAX(rev) INTO max_rev FROM revisions;
  IF max_rev IS NULL THEN
    PERFORM setval('revisions_rev_seq', 1, false);
  ELSE
    PERFORM setval('revisions_rev_seq', max_rev);
  END IF;
END;
$$;

DO $$
DECLARE
  pk_name TEXT;
  has_rev_unique BOOLEAN;
BEGIN
  SELECT tc.constraint_name
    INTO pk_name
    FROM information_schema.table_constraints tc
   WHERE tc.table_schema = 'public'
     AND tc.table_name = 'revisions'
     AND tc.constraint_type = 'PRIMARY KEY'
   LIMIT 1;

  IF pk_name IS NULL THEN
    EXECUTE 'ALTER TABLE revisions ADD PRIMARY KEY (rev)';
  ELSE
    SELECT EXISTS (
      SELECT 1
        FROM information_schema.key_column_usage kcu
       WHERE kcu.table_schema = 'public'
         AND kcu.table_name = 'revisions'
         AND kcu.constraint_name = pk_name
         AND kcu.column_name = 'rev'
    ) INTO has_rev_unique;

    IF NOT has_rev_unique THEN
      IF NOT EXISTS (
        SELECT 1
          FROM information_schema.table_constraints tc
         WHERE tc.table_schema = 'public'
           AND tc.table_name = 'revisions'
           AND tc.constraint_type = 'UNIQUE'
           AND tc.constraint_name = 'revisions_rev_key'
      ) THEN
        EXECUTE 'ALTER TABLE revisions ADD CONSTRAINT revisions_rev_key UNIQUE (rev)';
      END IF;
    END IF;
  END IF;

  EXECUTE 'ALTER TABLE revisions ALTER COLUMN rev SET NOT NULL';
  EXECUTE 'ALTER TABLE revisions ALTER COLUMN ts SET NOT NULL';
END;
$$;

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  login TEXT UNIQUE NOT NULL,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS processes (
  id SMALLSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  position SMALLINT NOT NULL DEFAULT 0,
  has_hours BOOLEAN NOT NULL DEFAULT TRUE,
  is_parallel BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS settings_autoweight (
  id SMALLINT PRIMARY KEY DEFAULT 1,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  percent SMALLINT NOT NULL DEFAULT 0,
  minimum_hours SMALLINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings_journal (
  id SMALLINT PRIMARY KEY DEFAULT 1,
  max_rows INTEGER NOT NULL DEFAULT 50,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings_column_widths (
  column_key TEXT PRIMARY KEY,
  width_px INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings_mapping (
  crm_stage TEXT PRIMARY KEY,
  planner_process_id SMALLINT REFERENCES processes(id) ON DELETE SET NULL,
  is_ignored BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings_admin (
  id SMALLINT PRIMARY KEY DEFAULT 1,
  allow_force_overwrite BOOLEAN NOT NULL DEFAULT FALSE,
  snapshot_retention INTEGER NOT NULL DEFAULT 50,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS excluded_statuses (
  status_key TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customers (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  crm_id TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  crm_order_id TEXT UNIQUE,
  number TEXT NOT NULL,
  customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS status TEXT;

CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);
CREATE INDEX IF NOT EXISTS orders_active_idx ON orders(id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS order_process (
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

CREATE INDEX IF NOT EXISTS order_process_process_position_idx ON order_process(process_id, position_index);
CREATE INDEX IF NOT EXISTS order_process_order_seq_idx ON order_process(order_id, seq);

CREATE TABLE IF NOT EXISTS capacity_by_process (
  process_id SMALLINT REFERENCES processes(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  minutes INTEGER NOT NULL,
  PRIMARY KEY (process_id, day)
);

CREATE TABLE IF NOT EXISTS activity_log (
  id BIGSERIAL PRIMARY KEY,
  rev BIGINT REFERENCES revisions(rev),
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor TEXT,
  source TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id BIGINT,
  details TEXT
);

CREATE INDEX IF NOT EXISTS activity_log_rev_idx ON activity_log(rev);

CREATE TABLE IF NOT EXISTS orders_hist (
  id BIGINT,
  crm_order_id TEXT,
  number TEXT,
  customer_id BIGINT,
  status TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  rev BIGINT NOT NULL REFERENCES revisions(rev),
  op CHAR(1) NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_process_hist (
  id BIGINT,
  order_id BIGINT,
  process_id SMALLINT,
  seq SMALLINT,
  planned_start TIMESTAMPTZ,
  planned_end TIMESTAMPTZ,
  actual_start TIMESTAMPTZ,
  actual_end TIMESTAMPTZ,
  progress SMALLINT,
  is_done BOOLEAN,
  position_index INTEGER,
  hidden_by_state BOOLEAN,
  updated_at TIMESTAMPTZ,
  rev BIGINT NOT NULL REFERENCES revisions(rev),
  op CHAR(1) NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS capacity_by_process_hist (
  process_id SMALLINT,
  day DATE,
  minutes INTEGER,
  rev BIGINT NOT NULL REFERENCES revisions(rev),
  op CHAR(1) NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings_autoweight_hist (
  id SMALLINT,
  enabled BOOLEAN,
  percent SMALLINT,
  minimum_hours SMALLINT,
  updated_at TIMESTAMPTZ,
  rev BIGINT NOT NULL REFERENCES revisions(rev),
  op CHAR(1) NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings_journal_hist (
  id SMALLINT,
  max_rows INTEGER,
  updated_at TIMESTAMPTZ,
  rev BIGINT NOT NULL REFERENCES revisions(rev),
  op CHAR(1) NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings_column_widths_hist (
  column_key TEXT,
  width_px INTEGER,
  updated_at TIMESTAMPTZ,
  rev BIGINT NOT NULL REFERENCES revisions(rev),
  op CHAR(1) NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings_mapping_hist (
  crm_stage TEXT,
  planner_process_id SMALLINT,
  is_ignored BOOLEAN,
  updated_at TIMESTAMPTZ,
  rev BIGINT NOT NULL REFERENCES revisions(rev),
  op CHAR(1) NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings_admin_hist (
  id SMALLINT,
  allow_force_overwrite BOOLEAN,
  snapshot_retention INTEGER,
  updated_at TIMESTAMPTZ,
  rev BIGINT NOT NULL REFERENCES revisions(rev),
  op CHAR(1) NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS excluded_statuses_hist (
  status_key TEXT,
  created_at TIMESTAMPTZ,
  rev BIGINT NOT NULL REFERENCES revisions(rev),
  op CHAR(1) NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION ensure_current_revision() RETURNS BIGINT AS $$
DECLARE
  rev_text TEXT;
  rev BIGINT;
BEGIN
  rev_text := current_setting('app.rev', true);
  IF rev_text IS NULL OR length(trim(rev_text)) = 0 THEN
    RAISE EXCEPTION 'app.rev is not set for history write';
  END IF;
  rev := rev_text::BIGINT;
  RETURN rev;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION generic_history_trigger() RETURNS trigger AS $$
DECLARE
  hist_table TEXT;
  rev BIGINT;
  op CHAR(1);
  sql TEXT;
BEGIN
  hist_table := TG_TABLE_NAME || '_hist';
  rev := ensure_current_revision();
  op := SUBSTRING(TG_OP, 1, 1);
  sql := format('INSERT INTO %I SELECT ($1).*, $2::bigint, $3::char', hist_table);
  IF TG_OP = 'DELETE' THEN
    EXECUTE sql USING OLD, rev, op;
    RETURN OLD;
  ELSE
    EXECUTE sql USING NEW, rev, op;
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_updated_at ON orders;
CREATE TRIGGER orders_updated_at
BEFORE UPDATE ON orders
FOR EACH ROW
EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS order_process_updated_at ON order_process;
CREATE TRIGGER order_process_updated_at
BEFORE UPDATE ON order_process
FOR EACH ROW
EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS orders_history_trg ON orders;
CREATE TRIGGER orders_history_trg
AFTER INSERT OR UPDATE OR DELETE ON orders
FOR EACH ROW
EXECUTE FUNCTION generic_history_trigger();

DROP TRIGGER IF EXISTS order_process_history_trg ON order_process;
CREATE TRIGGER order_process_history_trg
AFTER INSERT OR UPDATE OR DELETE ON order_process
FOR EACH ROW
EXECUTE FUNCTION generic_history_trigger();

DROP TRIGGER IF EXISTS capacity_by_process_history_trg ON capacity_by_process;
CREATE TRIGGER capacity_by_process_history_trg
AFTER INSERT OR UPDATE OR DELETE ON capacity_by_process
FOR EACH ROW
EXECUTE FUNCTION generic_history_trigger();

DROP TRIGGER IF EXISTS settings_autoweight_history_trg ON settings_autoweight;
CREATE TRIGGER settings_autoweight_history_trg
AFTER INSERT OR UPDATE OR DELETE ON settings_autoweight
FOR EACH ROW
EXECUTE FUNCTION generic_history_trigger();

DROP TRIGGER IF EXISTS settings_journal_history_trg ON settings_journal;
CREATE TRIGGER settings_journal_history_trg
AFTER INSERT OR UPDATE OR DELETE ON settings_journal
FOR EACH ROW
EXECUTE FUNCTION generic_history_trigger();

DROP TRIGGER IF EXISTS settings_column_widths_history_trg ON settings_column_widths;
CREATE TRIGGER settings_column_widths_history_trg
AFTER INSERT OR UPDATE OR DELETE ON settings_column_widths
FOR EACH ROW
EXECUTE FUNCTION generic_history_trigger();

DROP TRIGGER IF EXISTS settings_mapping_history_trg ON settings_mapping;
CREATE TRIGGER settings_mapping_history_trg
AFTER INSERT OR UPDATE OR DELETE ON settings_mapping
FOR EACH ROW
EXECUTE FUNCTION generic_history_trigger();

DROP TRIGGER IF EXISTS settings_admin_history_trg ON settings_admin;
CREATE TRIGGER settings_admin_history_trg
AFTER INSERT OR UPDATE OR DELETE ON settings_admin
FOR EACH ROW
EXECUTE FUNCTION generic_history_trigger();

DROP TRIGGER IF EXISTS excluded_statuses_history_trg ON excluded_statuses;
CREATE TRIGGER excluded_statuses_history_trg
AFTER INSERT OR UPDATE OR DELETE ON excluded_statuses
FOR EACH ROW
EXECUTE FUNCTION generic_history_trigger();

COMMIT;
