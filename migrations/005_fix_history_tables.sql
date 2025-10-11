BEGIN;

-- 1. На время правок снимаем history-триггеры, чтобы исключить записи в историю.
DROP TRIGGER IF EXISTS orders_history_trg ON orders;
DROP TRIGGER IF EXISTS order_process_history_trg ON order_process;
DROP TRIGGER IF EXISTS capacity_by_process_history_trg ON capacity_by_process;
DROP TRIGGER IF EXISTS settings_autoweight_history_trg ON settings_autoweight;
DROP TRIGGER IF EXISTS settings_journal_history_trg ON settings_journal;
DROP TRIGGER IF EXISTS settings_column_widths_history_trg ON settings_column_widths;
DROP TRIGGER IF EXISTS settings_mapping_history_trg ON settings_mapping;
DROP TRIGGER IF EXISTS settings_admin_history_trg ON settings_admin;
DROP TRIGGER IF EXISTS excluded_statuses_history_trg ON excluded_statuses;

-- 2. Гарантируем выравнивание всех history-таблиц с базовыми структурами.
SELECT rebuild_history_table('settings_admin');
SELECT rebuild_history_table('settings_autoweight');
SELECT rebuild_history_table('settings_journal');
SELECT rebuild_history_table('settings_column_widths');
SELECT rebuild_history_table('settings_mapping');
SELECT rebuild_history_table('excluded_statuses');
SELECT rebuild_history_table('orders');
SELECT rebuild_history_table('order_process');
SELECT rebuild_history_table('capacity_by_process');

-- После использования вспомогательной функции можно удалить её, чтобы не засорять схему.
DROP FUNCTION IF EXISTS rebuild_history_table(TEXT);

-- 3. На всякий случай переопределяем универсальный history-триггер актуальной версией.
CREATE OR REPLACE FUNCTION generic_history_trigger() RETURNS trigger AS $$
DECLARE
  hist_table TEXT := TG_TABLE_NAME || '_hist';
  rev BIGINT;
  op CHAR(1);
  base_columns TEXT[];
  insert_columns TEXT;
  select_columns TEXT;
  sql TEXT;
BEGIN
  SELECT ARRAY_AGG(att.attname ORDER BY att.attnum)
    INTO base_columns
    FROM pg_attribute att
    JOIN pg_class cls ON cls.oid = att.attrelid
    JOIN pg_namespace ns ON ns.oid = cls.relnamespace
   WHERE ns.nspname = TG_TABLE_SCHEMA
     AND cls.relname = TG_TABLE_NAME
     AND att.attnum > 0
     AND NOT att.attisdropped;

  IF base_columns IS NULL OR array_length(base_columns, 1) IS NULL THEN
    RAISE EXCEPTION 'Base table %.% has no columns for history trigger', TG_TABLE_SCHEMA, TG_TABLE_NAME;
  END IF;

  insert_columns := array_to_string(
    ARRAY(SELECT format('%I', col) FROM unnest(base_columns) AS col),
    ', '
  );

  select_columns := array_to_string(
    ARRAY(SELECT format('($1).%I', col) FROM unnest(base_columns) AS col),
    ', '
  );

  rev := ensure_current_revision();
  op := SUBSTRING(TG_OP, 1, 1);

  sql := format(
    'INSERT INTO %I.%I (%s, rev, op, changed_at) VALUES (%s, $2::bigint, $3::char, NOW())',
    TG_TABLE_SCHEMA,
    hist_table,
    insert_columns,
    select_columns
  );

  IF TG_OP = 'DELETE' THEN
    EXECUTE sql USING OLD, rev, op;
    RETURN OLD;
  ELSE
    EXECUTE sql USING NEW, rev, op;
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- 4. Возвращаем history-триггеры на места.
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

-- 5. Дополнительно убеждаемся, что последовательность revisions_rev_seq существует и привязана к колонке rev.
CREATE SEQUENCE IF NOT EXISTS revisions_rev_seq;
ALTER SEQUENCE revisions_rev_seq OWNED BY revisions.rev;
ALTER TABLE revisions
  ALTER COLUMN rev SET DEFAULT nextval('revisions_rev_seq');

COMMIT;
