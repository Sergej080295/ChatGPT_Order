BEGIN;

-- Снимаем пользовательские history-триггеры перед переразвертыванием схемы.
DROP TRIGGER IF EXISTS orders_history_trg ON orders;
DROP TRIGGER IF EXISTS order_process_history_trg ON order_process;
DROP TRIGGER IF EXISTS capacity_by_process_history_trg ON capacity_by_process;
DROP TRIGGER IF EXISTS settings_autoweight_history_trg ON settings_autoweight;
DROP TRIGGER IF EXISTS settings_journal_history_trg ON settings_journal;
DROP TRIGGER IF EXISTS settings_column_widths_history_trg ON settings_column_widths;
DROP TRIGGER IF EXISTS settings_mapping_history_trg ON settings_mapping;
DROP TRIGGER IF EXISTS settings_admin_history_trg ON settings_admin;
DROP TRIGGER IF EXISTS excluded_statuses_history_trg ON excluded_statuses;

-- Удаляем устаревшие таблицы JSON-хранилища.
DROP TABLE IF EXISTS stage_exception CASCADE;
DROP TABLE IF EXISTS stage_completion CASCADE;
DROP TABLE IF EXISTS order_stage CASCADE;
DROP TABLE IF EXISTS capacity_by_stage CASCADE;
DROP TABLE IF EXISTS parallel_limits CASCADE;
DROP TABLE IF EXISTS customer_order CASCADE;
DROP TABLE IF EXISTS stage_type CASCADE;
DROP TABLE IF EXISTS planner_settings CASCADE;
DROP TABLE IF EXISTS planner_activity_log CASCADE;
DROP TABLE IF EXISTS planner_state CASCADE;
DROP TABLE IF EXISTS planner_state_history CASCADE;

-- Выравниваем структуры *_hist таблиц под базовые.
DO $$
DECLARE
  pair RECORD;
  base_reg REGCLASS;
  col RECORD;
  column_defs TEXT[];
  column_names TEXT[];
  select_exprs TEXT[];
  has_hist BOOLEAN;
  hist_name TEXT;
  temp_name TEXT;
  rev_expr TEXT;
  op_expr TEXT;
  changed_expr TEXT;
BEGIN
  FOR pair IN
    SELECT * FROM (VALUES
      ('orders', 'orders_hist'),
      ('order_process', 'order_process_hist'),
      ('capacity_by_process', 'capacity_by_process_hist'),
      ('settings_autoweight', 'settings_autoweight_hist'),
      ('settings_journal', 'settings_journal_hist'),
      ('settings_column_widths', 'settings_column_widths_hist'),
      ('settings_mapping', 'settings_mapping_hist'),
      ('settings_admin', 'settings_admin_hist'),
      ('excluded_statuses', 'excluded_statuses_hist')
    ) AS t(base_table, hist_table)
  LOOP
    base_reg := format('public.%I', pair.base_table)::REGCLASS;
    column_defs := ARRAY[]::TEXT[];
    column_names := ARRAY[]::TEXT[];
    select_exprs := ARRAY[]::TEXT[];
    FOR col IN
      SELECT a.attname,
             pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
             a.attnotnull,
             pg_get_expr(ad.adbin, ad.adrelid) AS default_expr
        FROM pg_attribute a
        LEFT JOIN pg_attrdef ad
               ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
       WHERE a.attrelid = base_reg
         AND a.attnum > 0
         AND NOT a.attisdropped
       ORDER BY a.attnum
    LOOP
      column_defs := column_defs || format('%I %s%s%s',
        col.attname,
        col.data_type,
        CASE WHEN col.default_expr IS NOT NULL THEN ' DEFAULT ' || col.default_expr ELSE '' END,
        CASE WHEN col.attnotnull THEN ' NOT NULL' ELSE '' END
      );
      column_names := column_names || format('%I', col.attname);

      IF EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = pair.hist_table
           AND column_name = col.attname
      ) THEN
        IF col.attname = 'updated_at' THEN
          select_exprs := select_exprs || format('COALESCE(%I, NOW())', col.attname);
        ELSE
          select_exprs := select_exprs || format('%I', col.attname);
        END IF;
      ELSE
        IF col.attname = 'updated_at' THEN
          select_exprs := select_exprs || 'NOW()';
        ELSIF col.default_expr IS NOT NULL THEN
          select_exprs := select_exprs || col.default_expr;
        ELSE
          select_exprs := select_exprs || format('NULL::%s', col.data_type);
        END IF;
      END IF;
    END LOOP;

    column_defs := column_defs || 'rev BIGINT NOT NULL REFERENCES revisions(rev)';
    column_defs := column_defs || 'op CHAR(1) NOT NULL';
    column_defs := column_defs || 'changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()';

    column_names := column_names || 'rev';
    column_names := column_names || 'op';
    column_names := column_names || 'changed_at';

    SELECT EXISTS (
      SELECT 1
        FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = pair.hist_table
    ) INTO has_hist;

    hist_name := pair.hist_table;
    temp_name := pair.hist_table || '_rebuild';

    IF has_hist THEN
      SELECT CASE
               WHEN EXISTS (
                      SELECT 1 FROM information_schema.columns
                       WHERE table_schema = 'public'
                         AND table_name = pair.hist_table
                         AND column_name = 'rev'
                    ) THEN 'rev'
               ELSE 'NULL::BIGINT'
             END
        INTO rev_expr;

      SELECT CASE
               WHEN EXISTS (
                      SELECT 1 FROM information_schema.columns
                       WHERE table_schema = 'public'
                         AND table_name = pair.hist_table
                         AND column_name = 'op'
                    ) THEN 'op'
               ELSE '''U''::CHAR(1)'
             END
        INTO op_expr;

      SELECT CASE
               WHEN EXISTS (
                      SELECT 1 FROM information_schema.columns
                       WHERE table_schema = 'public'
                         AND table_name = pair.hist_table
                         AND column_name = 'changed_at'
                    ) THEN 'COALESCE(changed_at, NOW())'
               ELSE 'NOW()'
             END
        INTO changed_expr;

      select_exprs := select_exprs || rev_expr;
      select_exprs := select_exprs || op_expr;
      select_exprs := select_exprs || changed_expr;

      EXECUTE format('DROP TABLE IF EXISTS %I', temp_name);
      EXECUTE format('CREATE TABLE %I (%s)', temp_name, array_to_string(column_defs, ', '));
      EXECUTE format('INSERT INTO %I (%s) SELECT %s FROM %I',
        temp_name,
        array_to_string(column_names, ', '),
        array_to_string(select_exprs, ', '),
        hist_name
      );
      EXECUTE format('DROP TABLE %I', hist_name);
      EXECUTE format('ALTER TABLE %I RENAME TO %I', temp_name, hist_name);
    ELSE
      EXECUTE format('CREATE TABLE IF NOT EXISTS %I (%s)',
        hist_name,
        array_to_string(column_defs, ', ')
      );
    END IF;

    EXECUTE format('ALTER TABLE %I ALTER COLUMN changed_at SET DEFAULT NOW()', hist_name);
    EXECUTE format('DELETE FROM %I WHERE rev IS NULL', hist_name);

    IF NOT EXISTS (
      SELECT 1
        FROM information_schema.table_constraints tc
       WHERE tc.table_schema = 'public'
         AND tc.table_name = hist_name
         AND tc.constraint_name = hist_name || '_rev_fkey'
         AND tc.constraint_type = 'FOREIGN KEY'
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (rev) REFERENCES revisions(rev)',
        hist_name,
        hist_name || '_rev_fkey'
      );
    END IF;
  END LOOP;
END;
$$;

-- Чистим устаревшие hist_* функции.
DO $$
DECLARE
  fn RECORD;
BEGIN
  FOR fn IN
    SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname LIKE 'hist\_%'
  LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %I.%I(%s) CASCADE;', fn.nspname, fn.proname, fn.args);
  END LOOP;
END;
$$;

-- Современная реализация универсального history-триггера.
CREATE OR REPLACE FUNCTION generic_history_trigger() RETURNS trigger AS $$
DECLARE
  hist_identifier TEXT := format('%I.%I', TG_TABLE_SCHEMA, TG_TABLE_NAME || '_hist');
  base_columns TEXT[] := ARRAY[]::TEXT[];
  value_exprs TEXT[] := ARRAY[]::TEXT[];
  col RECORD;
  rev BIGINT;
  op CHAR(1);
  source_record RECORD;
BEGIN
  FOR col IN
    SELECT a.attname
      FROM pg_attribute a
     WHERE a.attrelid = TG_RELID
       AND a.attnum > 0
       AND NOT a.attisdropped
     ORDER BY a.attnum
  LOOP
    base_columns := base_columns || format('%I', col.attname);
    IF col.attname = 'updated_at' THEN
      value_exprs := value_exprs || format('COALESCE(($1).%I, NOW())', col.attname);
    ELSE
      value_exprs := value_exprs || format('($1).%I', col.attname);
    END IF;
  END LOOP;

  base_columns := base_columns || 'rev';
  base_columns := base_columns || 'op';
  base_columns := base_columns || 'changed_at';

  value_exprs := value_exprs || '$2::BIGINT';
  value_exprs := value_exprs || '$3::CHAR(1)';
  value_exprs := value_exprs || 'NOW()';

  rev := ensure_current_revision();
  op := SUBSTRING(TG_OP, 1, 1);
  source_record := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;

  EXECUTE format('INSERT INTO %s (%s) VALUES (%s)',
    hist_identifier,
    array_to_string(base_columns, ', '),
    array_to_string(value_exprs, ', ')
  ) USING source_record, rev, op;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Повторно навешиваем history-триггеры.
CREATE TRIGGER orders_history_trg
AFTER INSERT OR UPDATE OR DELETE ON orders
FOR EACH ROW
EXECUTE FUNCTION generic_history_trigger();

CREATE TRIGGER order_process_history_trg
AFTER INSERT OR UPDATE OR DELETE ON order_process
FOR EACH ROW
EXECUTE FUNCTION generic_history_trigger();

CREATE TRIGGER capacity_by_process_history_trg
AFTER INSERT OR UPDATE OR DELETE ON capacity_by_process
FOR EACH ROW
EXECUTE FUNCTION generic_history_trigger();

CREATE TRIGGER settings_autoweight_history_trg
AFTER INSERT OR UPDATE OR DELETE ON settings_autoweight
FOR EACH ROW
EXECUTE FUNCTION generic_history_trigger();

CREATE TRIGGER settings_journal_history_trg
AFTER INSERT OR UPDATE OR DELETE ON settings_journal
FOR EACH ROW
EXECUTE FUNCTION generic_history_trigger();

CREATE TRIGGER settings_column_widths_history_trg
AFTER INSERT OR UPDATE OR DELETE ON settings_column_widths
FOR EACH ROW
EXECUTE FUNCTION generic_history_trigger();

CREATE TRIGGER settings_mapping_history_trg
AFTER INSERT OR UPDATE OR DELETE ON settings_mapping
FOR EACH ROW
EXECUTE FUNCTION generic_history_trigger();

CREATE TRIGGER settings_admin_history_trg
AFTER INSERT OR UPDATE OR DELETE ON settings_admin
FOR EACH ROW
EXECUTE FUNCTION generic_history_trigger();

CREATE TRIGGER excluded_statuses_history_trg
AFTER INSERT OR UPDATE OR DELETE ON excluded_statuses
FOR EACH ROW
EXECUTE FUNCTION generic_history_trigger();

COMMIT;
