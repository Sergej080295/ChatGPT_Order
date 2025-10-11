BEGIN;

DO $$
DECLARE
  trig RECORD;
BEGIN
  -- Удаляем все старые history-триггеры, которые вызывают функции hist_*.
  FOR trig IN
    SELECT tg.tgname, tbl.relname
      FROM pg_trigger tg
      JOIN pg_class tbl ON tbl.oid = tg.tgrelid
      JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
      JOIN pg_proc fn ON fn.oid = tg.tgfoid
     WHERE NOT tg.tgisinternal
       AND ns.nspname = 'public'
       AND fn.proname LIKE 'hist\_%'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I;', trig.tgname, trig.relname);
  END LOOP;

  -- Сбрасываем стандартные *_history_trg для таблиц, которые будут пересозданы позже.
  FOR trig IN
    SELECT tg.tgname, tbl.relname
      FROM pg_trigger tg
      JOIN pg_class tbl ON tbl.oid = tg.tgrelid
      JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
     WHERE NOT tg.tgisinternal
       AND ns.nspname = 'public'
       AND tg.tgname LIKE '%\_history_trg' ESCAPE '\\'
       AND tbl.relname IN (
         'settings_admin',
         'settings_autoweight',
         'settings_journal',
         'settings_column_widths',
         'settings_mapping',
         'excluded_statuses',
         'orders',
         'order_process',
         'capacity_by_process'
       )
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I;', trig.tgname, trig.relname);
  END LOOP;
END;
$$;

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
       AND p.proname LIKE 'hist\_%'
  LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS public.%I(%s);', fn.proname, fn.args);
  END LOOP;
END;
$$;

ALTER TABLE settings_admin
  ADD COLUMN IF NOT EXISTS allow_force_overwrite BOOLEAN,
  ADD COLUMN IF NOT EXISTS snapshot_retention INTEGER,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

ALTER TABLE settings_admin
  ALTER COLUMN allow_force_overwrite SET DEFAULT FALSE,
  ALTER COLUMN snapshot_retention SET DEFAULT 50,
  ALTER COLUMN updated_at SET DEFAULT NOW();

DO $$
DECLARE
  select_parts TEXT[] := ARRAY[]::TEXT[];
  column_expr TEXT;
  has_hist BOOLEAN;
BEGIN
  SELECT EXISTS (
           SELECT 1
             FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name = 'settings_admin_hist'
         )
    INTO has_hist;

  IF NOT has_hist THEN
    EXECUTE 'CREATE TABLE IF NOT EXISTS settings_admin_hist (
               id SMALLINT,
               allow_force_overwrite BOOLEAN,
               snapshot_retention INTEGER,
               updated_at TIMESTAMPTZ,
               rev BIGINT NOT NULL REFERENCES revisions(rev),
               op CHAR(1) NOT NULL,
               changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
             )';
  ELSE
    select_parts := select_parts ||
      CASE
        WHEN EXISTS (
               SELECT 1
                 FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'settings_admin_hist'
                  AND column_name = 'id'
             ) THEN 'id'
        ELSE 'NULL::SMALLINT'
      END;

    select_parts := select_parts ||
      CASE
        WHEN EXISTS (
               SELECT 1
                 FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'settings_admin_hist'
                  AND column_name = 'allow_force_overwrite'
             ) THEN 'allow_force_overwrite'
        ELSE 'NULL::BOOLEAN'
      END;

    select_parts := select_parts ||
      CASE
        WHEN EXISTS (
               SELECT 1
                 FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'settings_admin_hist'
                  AND column_name = 'snapshot_retention'
             ) THEN 'snapshot_retention'
        ELSE '50::INTEGER'
      END;

    select_parts := select_parts ||
      CASE
        WHEN EXISTS (
               SELECT 1
                 FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'settings_admin_hist'
                  AND column_name = 'updated_at'
             ) THEN 'updated_at'
        ELSE 'NOW()'
      END;

    select_parts := select_parts ||
      CASE
        WHEN EXISTS (
               SELECT 1
                 FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'settings_admin_hist'
                  AND column_name = 'rev'
             ) THEN 'rev'
        ELSE 'NULL::BIGINT'
      END;

    select_parts := select_parts ||
      CASE
        WHEN EXISTS (
               SELECT 1
                 FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'settings_admin_hist'
                  AND column_name = 'op'
             ) THEN 'COALESCE(op, ''U'')'
        ELSE quote_literal('U') || '::CHAR(1)'
      END;

    select_parts := select_parts ||
      CASE
        WHEN EXISTS (
               SELECT 1
                 FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'settings_admin_hist'
                  AND column_name = 'changed_at'
             ) THEN 'changed_at'
        ELSE 'NOW()'
      END;

    column_expr := array_to_string(select_parts, ', ');

    EXECUTE 'DROP TABLE IF EXISTS settings_admin_hist_rebuild';

    EXECUTE 'CREATE TABLE settings_admin_hist_rebuild (
               id SMALLINT,
               allow_force_overwrite BOOLEAN,
               snapshot_retention INTEGER,
               updated_at TIMESTAMPTZ,
               rev BIGINT NOT NULL REFERENCES revisions(rev),
               op CHAR(1) NOT NULL,
               changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
             )';

    EXECUTE format(
      'INSERT INTO settings_admin_hist_rebuild (
         id,
         allow_force_overwrite,
         snapshot_retention,
         updated_at,
         rev,
         op,
         changed_at
       )
       SELECT %s FROM settings_admin_hist',
      column_expr
    );

    EXECUTE 'DROP TABLE settings_admin_hist';
    EXECUTE 'ALTER TABLE settings_admin_hist_rebuild RENAME TO settings_admin_hist';
  END IF;

  EXECUTE 'DELETE FROM settings_admin_hist WHERE rev IS NULL';
  EXECUTE 'ALTER TABLE settings_admin_hist ALTER COLUMN changed_at SET DEFAULT NOW()';
  EXECUTE 'ALTER TABLE settings_admin_hist ALTER COLUMN rev SET NOT NULL';
  EXECUTE 'ALTER TABLE settings_admin_hist ALTER COLUMN op SET NOT NULL';

  IF NOT EXISTS (
       SELECT 1
         FROM information_schema.table_constraints tc
        WHERE tc.table_schema = 'public'
          AND tc.table_name = 'settings_admin_hist'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND tc.constraint_name = 'settings_admin_hist_rev_fkey'
     ) THEN
    EXECUTE 'ALTER TABLE settings_admin_hist
               ADD CONSTRAINT settings_admin_hist_rev_fkey
               FOREIGN KEY (rev) REFERENCES revisions(rev)';
  END IF;
END;
$$;

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

DO $$
DECLARE
  new_rev BIGINT;
BEGIN
  SELECT nextval('revisions_rev_seq') INTO new_rev;
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

  INSERT INTO revisions (rev, actor, source, note)
  VALUES (new_rev, 'system', 'migration', 'backfill settings_admin defaults')
  ON CONFLICT (rev) DO NOTHING;

  PERFORM set_config('app.rev', '', true);
END;
$$;

ALTER TABLE settings_admin
  ALTER COLUMN allow_force_overwrite SET NOT NULL,
  ALTER COLUMN snapshot_retention SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;

COMMIT;
