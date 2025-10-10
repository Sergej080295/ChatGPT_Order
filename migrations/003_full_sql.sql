BEGIN;

-- Remove legacy snapshot tables if they still exist
DROP TABLE IF EXISTS planner_state_history;
DROP TABLE IF EXISTS planner_state;

CREATE TABLE IF NOT EXISTS revisions (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  current_rev BIGINT NOT NULL
);

INSERT INTO revisions (id, current_rev)
VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,
  client TEXT,
  name TEXT,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders_hist (
  id BIGINT NOT NULL,
  order_no TEXT NOT NULL,
  client TEXT,
  name TEXT,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  rev_from BIGINT NOT NULL,
  rev_to BIGINT,
  PRIMARY KEY (id, rev_from)
);

CREATE TABLE IF NOT EXISTS order_stages (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  stage_code TEXT NOT NULL,
  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  progress_pct INTEGER DEFAULT 0 CHECK (progress_pct >= 0 AND progress_pct <= 100),
  status TEXT,
  is_done BOOLEAN NOT NULL DEFAULT FALSE,
  trash_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS order_stages_order_idx ON order_stages(order_id);
CREATE INDEX IF NOT EXISTS order_stages_stage_idx ON order_stages(stage_code, is_done);

CREATE TABLE IF NOT EXISTS order_stages_hist (
  id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  stage_code TEXT NOT NULL,
  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  progress_pct INTEGER,
  status TEXT,
  is_done BOOLEAN,
  trash_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  rev_from BIGINT NOT NULL,
  rev_to BIGINT,
  PRIMARY KEY (id, rev_from)
);

CREATE TABLE IF NOT EXISTS stage_dependencies (
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_stage TEXT NOT NULL,
  to_stage TEXT NOT NULL,
  PRIMARY KEY (order_id, from_stage, to_stage)
);

CREATE TABLE IF NOT EXISTS stage_dependencies_hist (
  order_id BIGINT NOT NULL,
  from_stage TEXT NOT NULL,
  to_stage TEXT NOT NULL,
  rev_from BIGINT NOT NULL,
  rev_to BIGINT,
  PRIMARY KEY (order_id, from_stage, to_stage, rev_from)
);

CREATE TABLE IF NOT EXISTS stage_capacity (
  stage_code TEXT PRIMARY KEY,
  capacity_per_day INTEGER NOT NULL,
  parallel_limit INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stage_capacity_hist (
  stage_code TEXT NOT NULL,
  capacity_per_day INTEGER,
  parallel_limit INTEGER,
  updated_at TIMESTAMPTZ NOT NULL,
  rev_from BIGINT NOT NULL,
  rev_to BIGINT,
  PRIMARY KEY (stage_code, rev_from)
);

CREATE TABLE IF NOT EXISTS excluded_statuses (
  status_code TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS excluded_statuses_hist (
  status_code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  rev_from BIGINT NOT NULL,
  rev_to BIGINT,
  PRIMARY KEY (status_code, rev_from)
);

CREATE TABLE IF NOT EXISTS settings_autoweight (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  percent INTEGER DEFAULT 0,
  minimum_hours INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO settings_autoweight (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS settings_autoweight_hist (
  id INTEGER NOT NULL,
  enabled BOOLEAN,
  percent INTEGER,
  minimum_hours INTEGER,
  updated_at TIMESTAMPTZ NOT NULL,
  rev_from BIGINT NOT NULL,
  rev_to BIGINT,
  PRIMARY KEY (id, rev_from)
);

CREATE TABLE IF NOT EXISTS settings_journal (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  max_rows INTEGER NOT NULL DEFAULT 200,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO settings_journal (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS settings_journal_hist (
  id INTEGER NOT NULL,
  max_rows INTEGER,
  updated_at TIMESTAMPTZ NOT NULL,
  rev_from BIGINT NOT NULL,
  rev_to BIGINT,
  PRIMARY KEY (id, rev_from)
);

CREATE TABLE IF NOT EXISTS settings_columns (
  column_key TEXT PRIMARY KEY,
  width_px INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings_columns_hist (
  column_key TEXT NOT NULL,
  width_px INTEGER,
  updated_at TIMESTAMPTZ NOT NULL,
  rev_from BIGINT NOT NULL,
  rev_to BIGINT,
  PRIMARY KEY (column_key, rev_from)
);

CREATE TABLE IF NOT EXISTS settings_crm_mapping (
  crm_stage_name TEXT PRIMARY KEY,
  planner_stage_code TEXT,
  is_ignored BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings_crm_mapping_hist (
  crm_stage_name TEXT NOT NULL,
  planner_stage_code TEXT,
  is_ignored BOOLEAN,
  updated_at TIMESTAMPTZ NOT NULL,
  rev_from BIGINT NOT NULL,
  rev_to BIGINT,
  PRIMARY KEY (crm_stage_name, rev_from)
);

CREATE TABLE IF NOT EXISTS settings_admin (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  allow_force_overwrite BOOLEAN NOT NULL DEFAULT FALSE,
  history_retention_count INTEGER NOT NULL DEFAULT 50,
  checkpoint_interval_days INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO settings_admin (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS settings_admin_hist (
  id INTEGER NOT NULL,
  allow_force_overwrite BOOLEAN,
  history_retention_count INTEGER,
  checkpoint_interval_days INTEGER,
  updated_at TIMESTAMPTZ NOT NULL,
  rev_from BIGINT NOT NULL,
  rev_to BIGINT,
  PRIMARY KEY (id, rev_from)
);

CREATE TABLE IF NOT EXISTS activity_log (
  id BIGSERIAL PRIMARY KEY,
  rev BIGINT NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor TEXT,
  source TEXT,
  action TEXT,
  summary TEXT
);

CREATE INDEX IF NOT EXISTS activity_log_rev_idx ON activity_log (rev DESC);

CREATE TABLE IF NOT EXISTS checkpoints (
  id BIGSERIAL PRIMARY KEY,
  rev BIGINT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note TEXT
);

CREATE OR REPLACE FUNCTION ensure_current_revision() RETURNS BIGINT AS $$
DECLARE
  rev BIGINT;
BEGIN
  BEGIN
    rev := current_setting('planner.current_rev', true)::BIGINT;
  EXCEPTION WHEN OTHERS THEN
    rev := NULL;
  END;
  IF rev IS NULL THEN
    RAISE EXCEPTION 'planner.current_rev is not set for history trigger';
  END IF;
  RETURN rev;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hist_apply_orders() RETURNS trigger AS $$
DECLARE
  rev BIGINT := ensure_current_revision();
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO orders_hist (id, order_no, client, name, deleted_at, created_at, updated_at, rev_from, rev_to)
    VALUES (NEW.id, NEW.order_no, NEW.client, NEW.name, NEW.deleted_at, NEW.created_at, NEW.updated_at, rev, NULL);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE orders_hist SET rev_to = rev - 1 WHERE id = OLD.id AND rev_to IS NULL;
    INSERT INTO orders_hist (id, order_no, client, name, deleted_at, created_at, updated_at, rev_from, rev_to)
    VALUES (NEW.id, NEW.order_no, NEW.client, NEW.name, NEW.deleted_at, NEW.created_at, NEW.updated_at, rev, NULL);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE orders_hist SET rev_to = rev WHERE id = OLD.id AND rev_to IS NULL;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hist_apply_order_stages() RETURNS trigger AS $$
DECLARE
  rev BIGINT := ensure_current_revision();
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO order_stages_hist (id, order_id, stage_code, start_at, end_at, progress_pct, status, is_done, trash_at, created_at, updated_at, rev_from, rev_to)
    VALUES (NEW.id, NEW.order_id, NEW.stage_code, NEW.start_at, NEW.end_at, NEW.progress_pct, NEW.status, NEW.is_done, NEW.trash_at, NEW.created_at, NEW.updated_at, rev, NULL);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE order_stages_hist SET rev_to = rev - 1 WHERE id = OLD.id AND rev_to IS NULL;
    INSERT INTO order_stages_hist (id, order_id, stage_code, start_at, end_at, progress_pct, status, is_done, trash_at, created_at, updated_at, rev_from, rev_to)
    VALUES (NEW.id, NEW.order_id, NEW.stage_code, NEW.start_at, NEW.end_at, NEW.progress_pct, NEW.status, NEW.is_done, NEW.trash_at, NEW.created_at, NEW.updated_at, rev, NULL);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE order_stages_hist SET rev_to = rev WHERE id = OLD.id AND rev_to IS NULL;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hist_apply_stage_dependencies() RETURNS trigger AS $$
DECLARE
  rev BIGINT := ensure_current_revision();
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO stage_dependencies_hist (order_id, from_stage, to_stage, rev_from, rev_to)
    VALUES (NEW.order_id, NEW.from_stage, NEW.to_stage, rev, NULL);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE stage_dependencies_hist SET rev_to = rev WHERE order_id = OLD.order_id AND from_stage = OLD.from_stage AND to_stage = OLD.to_stage AND rev_to IS NULL;
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE stage_dependencies_hist SET rev_to = rev - 1 WHERE order_id = OLD.order_id AND from_stage = OLD.from_stage AND to_stage = OLD.to_stage AND rev_to IS NULL;
    INSERT INTO stage_dependencies_hist (order_id, from_stage, to_stage, rev_from, rev_to)
    VALUES (NEW.order_id, NEW.from_stage, NEW.to_stage, rev, NULL);
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hist_apply_stage_capacity() RETURNS trigger AS $$
DECLARE
  rev BIGINT := ensure_current_revision();
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO stage_capacity_hist (stage_code, capacity_per_day, parallel_limit, updated_at, rev_from, rev_to)
    VALUES (NEW.stage_code, NEW.capacity_per_day, NEW.parallel_limit, NEW.updated_at, rev, NULL);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE stage_capacity_hist SET rev_to = rev - 1 WHERE stage_code = OLD.stage_code AND rev_to IS NULL;
    INSERT INTO stage_capacity_hist (stage_code, capacity_per_day, parallel_limit, updated_at, rev_from, rev_to)
    VALUES (NEW.stage_code, NEW.capacity_per_day, NEW.parallel_limit, NEW.updated_at, rev, NULL);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE stage_capacity_hist SET rev_to = rev WHERE stage_code = OLD.stage_code AND rev_to IS NULL;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hist_apply_excluded_statuses() RETURNS trigger AS $$
DECLARE
  rev BIGINT := ensure_current_revision();
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO excluded_statuses_hist (status_code, created_at, rev_from, rev_to)
    VALUES (NEW.status_code, NEW.created_at, rev, NULL);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE excluded_statuses_hist SET rev_to = rev WHERE status_code = OLD.status_code AND rev_to IS NULL;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hist_apply_settings_autoweight() RETURNS trigger AS $$
DECLARE
  rev BIGINT := ensure_current_revision();
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO settings_autoweight_hist (id, enabled, percent, minimum_hours, updated_at, rev_from, rev_to)
    VALUES (NEW.id, NEW.enabled, NEW.percent, NEW.minimum_hours, NEW.updated_at, rev, NULL);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE settings_autoweight_hist SET rev_to = rev - 1 WHERE id = OLD.id AND rev_to IS NULL;
    INSERT INTO settings_autoweight_hist (id, enabled, percent, minimum_hours, updated_at, rev_from, rev_to)
    VALUES (NEW.id, NEW.enabled, NEW.percent, NEW.minimum_hours, NEW.updated_at, rev, NULL);
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hist_apply_settings_journal() RETURNS trigger AS $$
DECLARE
  rev BIGINT := ensure_current_revision();
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO settings_journal_hist (id, max_rows, updated_at, rev_from, rev_to)
    VALUES (NEW.id, NEW.max_rows, NEW.updated_at, rev, NULL);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE settings_journal_hist SET rev_to = rev - 1 WHERE id = OLD.id AND rev_to IS NULL;
    INSERT INTO settings_journal_hist (id, max_rows, updated_at, rev_from, rev_to)
    VALUES (NEW.id, NEW.max_rows, NEW.updated_at, rev, NULL);
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hist_apply_settings_columns() RETURNS trigger AS $$
DECLARE
  rev BIGINT := ensure_current_revision();
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO settings_columns_hist (column_key, width_px, updated_at, rev_from, rev_to)
    VALUES (NEW.column_key, NEW.width_px, NEW.updated_at, rev, NULL);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE settings_columns_hist SET rev_to = rev - 1 WHERE column_key = OLD.column_key AND rev_to IS NULL;
    INSERT INTO settings_columns_hist (column_key, width_px, updated_at, rev_from, rev_to)
    VALUES (NEW.column_key, NEW.width_px, NEW.updated_at, rev, NULL);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE settings_columns_hist SET rev_to = rev WHERE column_key = OLD.column_key AND rev_to IS NULL;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hist_apply_settings_crm_mapping() RETURNS trigger AS $$
DECLARE
  rev BIGINT := ensure_current_revision();
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO settings_crm_mapping_hist (crm_stage_name, planner_stage_code, is_ignored, updated_at, rev_from, rev_to)
    VALUES (NEW.crm_stage_name, NEW.planner_stage_code, NEW.is_ignored, NEW.updated_at, rev, NULL);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE settings_crm_mapping_hist SET rev_to = rev - 1 WHERE crm_stage_name = OLD.crm_stage_name AND rev_to IS NULL;
    INSERT INTO settings_crm_mapping_hist (crm_stage_name, planner_stage_code, is_ignored, updated_at, rev_from, rev_to)
    VALUES (NEW.crm_stage_name, NEW.planner_stage_code, NEW.is_ignored, NEW.updated_at, rev, NULL);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE settings_crm_mapping_hist SET rev_to = rev WHERE crm_stage_name = OLD.crm_stage_name AND rev_to IS NULL;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hist_apply_settings_admin() RETURNS trigger AS $$
DECLARE
  rev BIGINT := ensure_current_revision();
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO settings_admin_hist (id, allow_force_overwrite, history_retention_count, checkpoint_interval_days, updated_at, rev_from, rev_to)
    VALUES (NEW.id, NEW.allow_force_overwrite, NEW.history_retention_count, NEW.checkpoint_interval_days, NEW.updated_at, rev, NULL);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE settings_admin_hist SET rev_to = rev - 1 WHERE id = OLD.id AND rev_to IS NULL;
    INSERT INTO settings_admin_hist (id, allow_force_overwrite, history_retention_count, checkpoint_interval_days, updated_at, rev_from, rev_to)
    VALUES (NEW.id, NEW.allow_force_overwrite, NEW.history_retention_count, NEW.checkpoint_interval_days, NEW.updated_at, rev, NULL);
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER orders_touch BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER orders_hist AFTER INSERT OR UPDATE OR DELETE ON orders FOR EACH ROW EXECUTE FUNCTION hist_apply_orders();

CREATE TRIGGER order_stages_touch BEFORE UPDATE ON order_stages FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER order_stages_hist AFTER INSERT OR UPDATE OR DELETE ON order_stages FOR EACH ROW EXECUTE FUNCTION hist_apply_order_stages();

CREATE TRIGGER stage_capacity_touch BEFORE UPDATE ON stage_capacity FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER stage_capacity_hist_trigger AFTER INSERT OR UPDATE OR DELETE ON stage_capacity FOR EACH ROW EXECUTE FUNCTION hist_apply_stage_capacity();

CREATE TRIGGER excluded_statuses_hist_trigger AFTER INSERT OR DELETE ON excluded_statuses FOR EACH ROW EXECUTE FUNCTION hist_apply_excluded_statuses();

CREATE TRIGGER settings_autoweight_touch BEFORE UPDATE ON settings_autoweight FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER settings_autoweight_hist_trigger AFTER INSERT OR UPDATE ON settings_autoweight FOR EACH ROW EXECUTE FUNCTION hist_apply_settings_autoweight();

CREATE TRIGGER settings_journal_touch BEFORE UPDATE ON settings_journal FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER settings_journal_hist_trigger AFTER INSERT OR UPDATE ON settings_journal FOR EACH ROW EXECUTE FUNCTION hist_apply_settings_journal();

CREATE TRIGGER settings_columns_touch BEFORE UPDATE ON settings_columns FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER settings_columns_hist_trigger AFTER INSERT OR UPDATE OR DELETE ON settings_columns FOR EACH ROW EXECUTE FUNCTION hist_apply_settings_columns();

CREATE TRIGGER settings_crm_mapping_touch BEFORE UPDATE ON settings_crm_mapping FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER settings_crm_mapping_hist_trigger AFTER INSERT OR UPDATE OR DELETE ON settings_crm_mapping FOR EACH ROW EXECUTE FUNCTION hist_apply_settings_crm_mapping();

CREATE TRIGGER settings_admin_touch BEFORE UPDATE ON settings_admin FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER settings_admin_hist_trigger AFTER INSERT OR UPDATE ON settings_admin FOR EACH ROW EXECUTE FUNCTION hist_apply_settings_admin();

CREATE TRIGGER stage_dependencies_hist_trigger AFTER INSERT OR UPDATE OR DELETE ON stage_dependencies FOR EACH ROW EXECUTE FUNCTION hist_apply_stage_dependencies();

COMMIT;
