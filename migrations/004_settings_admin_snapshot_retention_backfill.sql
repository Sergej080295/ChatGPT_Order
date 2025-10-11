BEGIN;

-- 1. Удаляем пользовательские триггеры, которые все ещё ссылаются на устаревшие hist_* функции.
DO $$
DECLARE
  trig RECORD;
BEGIN
  FOR trig IN
    SELECT ns.nspname AS schema_name,
           tbl.relname AS table_name,
           tg.tgname AS trigger_name
      FROM pg_trigger tg
      JOIN pg_class tbl ON tbl.oid = tg.tgrelid
      JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
      JOIN pg_proc fn ON fn.oid = tg.tgfoid
     WHERE NOT tg.tgisinternal
       AND ns.nspname NOT IN ('pg_catalog', 'information_schema')
       AND fn.proname LIKE 'hist\\_%'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I.%I;', trig.trigger_name, trig.schema_name, trig.table_name);
  END LOOP;
END;
$$;

-- 2. Снимаем стандартные history-триггеры, чтобы безопасно пересоздать схему.
DROP TRIGGER IF EXISTS orders_history_trg ON orders;
DROP TRIGGER IF EXISTS order_process_history_trg ON order_process;
DROP TRIGGER IF EXISTS capacity_by_process_history_trg ON capacity_by_process;
DROP TRIGGER IF EXISTS settings_autoweight_history_trg ON settings_autoweight;
DROP TRIGGER IF EXISTS settings_journal_history_trg ON settings_journal;
DROP TRIGGER IF EXISTS settings_column_widths_history_trg ON settings_column_widths;
DROP TRIGGER IF EXISTS settings_mapping_history_trg ON settings_mapping;
DROP TRIGGER IF EXISTS settings_admin_history_trg ON settings_admin;
DROP TRIGGER IF EXISTS excluded_statuses_history_trg ON excluded_statuses;

-- Дополнительно удаляем все пользовательские триггеры на целевых таблицах,
-- чтобы исключить зависание устаревших hist_* обработчиков.
DO $$
DECLARE
  trig RECORD;
BEGIN
  FOR trig IN
    SELECT ns.nspname AS schema_name,
           tbl.relname AS table_name,
           tg.tgname AS trigger_name
      FROM pg_trigger tg
      JOIN pg_class tbl ON tbl.oid = tg.tgrelid
      JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
      LEFT JOIN pg_proc fn ON fn.oid = tg.tgfoid
     WHERE NOT tg.tgisinternal
       AND ns.nspname = 'public'
       AND tbl.relname IN (
         'orders',
         'order_process',
         'capacity_by_process',
         'settings_autoweight',
         'settings_journal',
         'settings_column_widths',
         'settings_mapping',
         'settings_admin',
         'excluded_statuses'
       )
       AND (
         (fn.proname IS NOT NULL AND fn.proname LIKE 'hist\_%') OR
         tg.tgname LIKE '%hist%'
       )
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I.%I;', trig.trigger_name, trig.schema_name, trig.table_name);
  END LOOP;
END;
$$;

-- 3. Удаляем устаревшие функции hist_*.
DO $$
DECLARE
  fn RECORD;
BEGIN
  FOR fn IN
    SELECT p.proname,
           pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname LIKE 'hist\\_%'
  LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS public.%I(%s) CASCADE;', fn.proname, fn.args);
  END LOOP;
END;
$$;

-- На некоторых установках могла сохраниться старая версия hist_apply_settings_admin без зависимостей,
-- поэтому удаляем её напрямую, чтобы исключить обращения к колонке rev_to.
DROP FUNCTION IF EXISTS public.hist_apply_settings_admin() CASCADE;

-- 4. Вспомогательная функция выравнивания структуры history-таблицы под базовую.
CREATE OR REPLACE FUNCTION rebuild_history_table(base_table TEXT) RETURNS VOID AS $$
DECLARE
  base_schema TEXT := 'public';
  hist_table TEXT := base_table || '_hist';
  hist_exists BOOLEAN;
  has_rows BOOLEAN := false;
  base_col RECORD;
  column_defs TEXT := '';
  insert_columns TEXT := '';
  select_columns TEXT := '';
  hist_has_column BOOLEAN;
  hist_has_rev BOOLEAN := false;
  hist_has_op BOOLEAN := false;
  hist_has_changed_at BOOLEAN := false;
  backfill_rev BIGINT;
  rev_expr TEXT;
  op_expr TEXT;
  changed_expr TEXT;
  copy_sql TEXT;
  constraint_name TEXT := hist_table || '_rev_fkey';
  revisions_has_current BOOLEAN := false;
  revisions_has_id BOOLEAN := false;
BEGIN
  SELECT to_regclass(format('%I.%I', base_schema, hist_table)) IS NOT NULL
    INTO hist_exists;

  SELECT EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'revisions'
              AND column_name = 'current_rev'
         )
    INTO revisions_has_current;

  SELECT EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'revisions'
              AND column_name = 'id'
         )
    INTO revisions_has_id;

  IF hist_exists THEN
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I)', base_schema, hist_table)
      INTO has_rows;

    SELECT EXISTS (
             SELECT 1
               FROM information_schema.columns
              WHERE table_schema = base_schema
                AND table_name = hist_table
                AND column_name = 'rev'
           )
      INTO hist_has_rev;

    SELECT EXISTS (
             SELECT 1
               FROM information_schema.columns
              WHERE table_schema = base_schema
                AND table_name = hist_table
                AND column_name = 'op'
           )
      INTO hist_has_op;

    SELECT EXISTS (
             SELECT 1
               FROM information_schema.columns
              WHERE table_schema = base_schema
                AND table_name = hist_table
                AND column_name = 'changed_at'
           )
      INTO hist_has_changed_at;
  END IF;

  FOR base_col IN
    SELECT a.attname AS column_name,
           format_type(a.atttypid, a.atttypmod) AS data_type,
           pg_get_expr(ad.adbin, ad.adrelid) AS column_default
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
     WHERE n.nspname = base_schema
       AND c.relname = base_table
       AND a.attnum > 0
       AND NOT a.attisdropped
     ORDER BY a.attnum
  LOOP
    column_defs := column_defs ||
      CASE WHEN column_defs = '' THEN '' ELSE ', ' END ||
      format('%I %s', base_col.column_name, base_col.data_type);

    insert_columns := insert_columns ||
      CASE WHEN insert_columns = '' THEN '' ELSE ', ' END ||
      format('%I', base_col.column_name);

    IF hist_exists THEN
      SELECT EXISTS (
               SELECT 1
                 FROM information_schema.columns
                WHERE table_schema = base_schema
                  AND table_name = hist_table
                  AND column_name = base_col.column_name
             )
        INTO hist_has_column;
    ELSE
      hist_has_column := false;
    END IF;

    IF hist_has_column THEN
      select_columns := select_columns ||
        CASE WHEN select_columns = '' THEN '' ELSE ', ' END ||
        format('src.%I', base_col.column_name);
    ELSIF base_col.column_default IS NOT NULL
       AND POSITION('nextval' IN lower(base_col.column_default)) = 0 THEN
      select_columns := select_columns ||
        CASE WHEN select_columns = '' THEN '' ELSE ', ' END ||
        format('(%s)::%s', base_col.column_default, base_col.data_type);
    ELSE
      select_columns := select_columns ||
        CASE WHEN select_columns = '' THEN '' ELSE ', ' END ||
        format('NULL::%s', base_col.data_type);
    END IF;
  END LOOP;

  IF column_defs = '' THEN
    RAISE EXCEPTION 'Base table %.% has no columns', base_schema, base_table;
  END IF;

  IF has_rows AND NOT hist_has_rev THEN
    SELECT nextval('revisions_rev_seq') INTO backfill_rev;

    IF revisions_has_current THEN
      IF revisions_has_id THEN
        EXECUTE '
          INSERT INTO revisions (id, rev, current_rev, actor, source, note)
          VALUES ($1, $1, $1, $2, $3, $4)
          ON CONFLICT (rev) DO NOTHING
        ' USING backfill_rev, 'system', 'migration', format('legacy history backfill for %s_hist', base_table);
      ELSE
        EXECUTE '
          INSERT INTO revisions (rev, current_rev, actor, source, note)
          VALUES ($1, $1, $2, $3, $4)
          ON CONFLICT (rev) DO NOTHING
        ' USING backfill_rev, 'system', 'migration', format('legacy history backfill for %s_hist', base_table);
      END IF;
    ELSE
      IF revisions_has_id THEN
        EXECUTE '
          INSERT INTO revisions (id, rev, actor, source, note)
          VALUES ($1, $1, $2, $3, $4)
          ON CONFLICT (rev) DO NOTHING
        ' USING backfill_rev, 'system', 'migration', format('legacy history backfill for %s_hist', base_table);
      ELSE
        EXECUTE '
          INSERT INTO revisions (rev, actor, source, note)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (rev) DO NOTHING
        ' USING backfill_rev, 'system', 'migration', format('legacy history backfill for %s_hist', base_table);
      END IF;
    END IF;
  END IF;

  EXECUTE format('DROP TABLE IF EXISTS %I.%I_rebuild', base_schema, hist_table);
  EXECUTE format(
    'CREATE TABLE %I.%I_rebuild (%s, rev BIGINT NOT NULL, op CHAR(1) NOT NULL, changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW())',
    base_schema,
    hist_table,
    column_defs
  );

  IF hist_exists AND has_rows THEN
    rev_expr := CASE
      WHEN hist_has_rev THEN 'src.rev'
      ELSE format('%L::bigint', backfill_rev)
    END;

    op_expr := CASE
      WHEN hist_has_op THEN 'COALESCE(src.op, ''U'')'
      ELSE '''U'''
    END;

    changed_expr := CASE
      WHEN hist_has_changed_at THEN 'COALESCE(src.changed_at, NOW())'
      ELSE 'NOW()'
    END;

    copy_sql := format(
      'INSERT INTO %I.%I_rebuild (%s, rev, op, changed_at)
         SELECT %s, %s, %s, %s
           FROM %I.%I AS src%s',
      base_schema,
      hist_table,
      insert_columns,
      select_columns,
      rev_expr,
      op_expr,
      changed_expr,
      base_schema,
      hist_table,
      CASE WHEN hist_has_rev THEN ' WHERE src.rev IS NOT NULL' ELSE '' END
    );

    EXECUTE copy_sql;

    EXECUTE format('DROP TABLE %I.%I', base_schema, hist_table);
  ELSIF hist_exists THEN
    EXECUTE format('DROP TABLE %I.%I', base_schema, hist_table);
  END IF;

  EXECUTE format('ALTER TABLE %I.%I_rebuild RENAME TO %I', base_schema, hist_table, hist_table);

  BEGIN
    EXECUTE format(
      'ALTER TABLE %I.%I ADD CONSTRAINT %I FOREIGN KEY (rev) REFERENCES revisions(rev)',
      base_schema,
      hist_table,
      constraint_name
    );
  EXCEPTION
    WHEN duplicate_object THEN
      NULL;
  END;

  EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN rev SET NOT NULL', base_schema, hist_table);
  EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN op SET NOT NULL', base_schema, hist_table);
  EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN changed_at SET NOT NULL', base_schema, hist_table);
  EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN changed_at SET DEFAULT NOW()', base_schema, hist_table);
END;
$$ LANGUAGE plpgsql;

-- 5. Гарантируем наличие всех необходимых колонок и дефолтов в settings_admin.
ALTER TABLE settings_admin
  ADD COLUMN IF NOT EXISTS allow_force_overwrite BOOLEAN,
  ADD COLUMN IF NOT EXISTS snapshot_retention INTEGER,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

ALTER TABLE settings_admin
  ALTER COLUMN allow_force_overwrite SET DEFAULT FALSE,
  ALTER COLUMN snapshot_retention SET DEFAULT 50,
  ALTER COLUMN updated_at SET DEFAULT NOW();

-- Перед выравниванием истории убеждаемся, что при наличии наследованной колонки id
-- у таблицы revisions настроен дефолт, чтобы вспомогательный бэкоф мог без ошибок
-- записывать новые ревизии.
DO $$
DECLARE
  has_id BOOLEAN := false;
  id_has_default BOOLEAN := false;
  seq_name TEXT;
  max_id BIGINT;
BEGIN
  SELECT EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'revisions'
              AND column_name = 'id'
         )
    INTO has_id;

  IF has_id THEN
    SELECT (column_default IS NOT NULL)
      INTO id_has_default
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'revisions'
       AND column_name = 'id'
     LIMIT 1;

    IF id_has_default IS NULL THEN
      id_has_default := false;
    END IF;

    IF NOT id_has_default THEN
      SELECT pg_get_serial_sequence('public.revisions', 'id') INTO seq_name;

      IF seq_name IS NULL THEN
        seq_name := 'public.revisions_id_seq';
        EXECUTE 'CREATE SEQUENCE IF NOT EXISTS public.revisions_id_seq';
      ELSE
        EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %s', seq_name);
      END IF;

      EXECUTE 'SELECT MAX(id) FROM public.revisions' INTO max_id;

      IF max_id IS NULL THEN
        EXECUTE format('SELECT setval(%L, 1, false)', seq_name);
      ELSE
        EXECUTE format('SELECT setval(%L, %s, true)', seq_name, max_id);
      END IF;

      EXECUTE format('ALTER TABLE public.revisions ALTER COLUMN id SET DEFAULT nextval(%L)', seq_name);
      EXECUTE format('ALTER SEQUENCE %s OWNED BY public.revisions.id', seq_name);
    END IF;
  END IF;
END;
$$;

-- 6. Выравниваем структуру settings_admin_hist.
DO $$
DECLARE
  has_current BOOLEAN := false;
BEGIN
  SELECT EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'revisions'
              AND column_name = 'current_rev'
         )
    INTO has_current;

  IF has_current THEN
    EXECUTE 'UPDATE public.revisions SET current_rev = rev WHERE current_rev IS NULL';
  END IF;
END;
$$;

SELECT rebuild_history_table('settings_admin');

-- 7. Актуализируем универсальный history-триггер.
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

-- 8. Возвращаем history-триггеры.
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

-- 9. Backfill данных и история в рамках новой ревизии.
DO $$
DECLARE
  new_rev BIGINT;
  has_current_rev BOOLEAN;
  has_id_column BOOLEAN;
  seq_name TEXT;
BEGIN
  SELECT nextval('revisions_rev_seq') INTO new_rev;

  SELECT EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'revisions'
              AND column_name = 'current_rev'
         )
    INTO has_current_rev;

  SELECT EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'revisions'
              AND column_name = 'id'
         )
    INTO has_id_column;

  IF has_current_rev THEN
    IF has_id_column THEN
      EXECUTE '
        INSERT INTO revisions (id, rev, current_rev, actor, source, note)
        VALUES ($1, $1, $1, $2, $3, $4)
        ON CONFLICT (rev) DO NOTHING
      ' USING new_rev, 'system', 'migration', 'backfill settings_admin defaults';
    ELSE
      EXECUTE '
        INSERT INTO revisions (rev, current_rev, actor, source, note)
        VALUES ($1, $1, $2, $3, $4)
        ON CONFLICT (rev) DO NOTHING
      ' USING new_rev, 'system', 'migration', 'backfill settings_admin defaults';
    END IF;
  ELSE
    IF has_id_column THEN
      EXECUTE '
        INSERT INTO revisions (id, rev, actor, source, note)
        VALUES ($1, $1, $2, $3, $4)
        ON CONFLICT (rev) DO NOTHING
      ' USING new_rev, 'system', 'migration', 'backfill settings_admin defaults';
    ELSE
      INSERT INTO revisions (rev, actor, source, note)
      VALUES (new_rev, 'system', 'migration', 'backfill settings_admin defaults')
      ON CONFLICT (rev) DO NOTHING;
    END IF;
  END IF;

  PERFORM set_config('app.rev', new_rev::TEXT, true);

  UPDATE settings_admin
     SET allow_force_overwrite = FALSE
   WHERE allow_force_overwrite IS NULL;

  UPDATE settings_admin
     SET snapshot_retention = 50
   WHERE snapshot_retention IS NULL;

  UPDATE settings_admin
     SET updated_at = NOW()
   WHERE updated_at IS NULL;

  INSERT INTO settings_admin (id, allow_force_overwrite, snapshot_retention, updated_at)
  VALUES (1, FALSE, 50, NOW())
  ON CONFLICT (id) DO UPDATE
        SET allow_force_overwrite = EXCLUDED.allow_force_overwrite,
            snapshot_retention = EXCLUDED.snapshot_retention,
            updated_at = NOW();

  PERFORM set_config('app.rev', NULL, true);

  IF has_id_column THEN
    SELECT pg_get_serial_sequence('public.revisions', 'id') INTO seq_name;
    IF seq_name IS NULL THEN
      seq_name := 'public.revisions_id_seq';
    END IF;
    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %s', seq_name);
    EXECUTE format('SELECT setval(%L, (SELECT COALESCE(MAX(id), 0) FROM public.revisions), true)', seq_name);
    EXECUTE format('ALTER TABLE public.revisions ALTER COLUMN id SET DEFAULT nextval(%L)', seq_name);
    EXECUTE format('ALTER SEQUENCE %s OWNED BY public.revisions.id', seq_name);
  END IF;
END;
$$;

ALTER TABLE settings_admin
  ALTER COLUMN allow_force_overwrite SET NOT NULL,
  ALTER COLUMN snapshot_retention SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;

COMMIT;
