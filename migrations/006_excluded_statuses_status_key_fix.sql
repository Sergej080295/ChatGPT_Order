BEGIN;

-- Ensure excluded_statuses table exposes status_key column expected by server code.
DO $$
DECLARE
  has_status_key BOOLEAN := FALSE;
  has_status BOOLEAN := FALSE;
BEGIN
  SELECT EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'excluded_statuses'
              AND column_name = 'status_key'
         )
    INTO has_status_key;

  SELECT EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'excluded_statuses'
              AND column_name = 'status'
         )
    INTO has_status;

  IF NOT has_status_key THEN
    IF has_status THEN
      EXECUTE 'ALTER TABLE public.excluded_statuses RENAME COLUMN status TO status_key';
    ELSE
      EXECUTE 'ALTER TABLE public.excluded_statuses ADD COLUMN status_key TEXT';
    END IF;
  ELSIF has_status THEN
    EXECUTE 'UPDATE public.excluded_statuses SET status_key = status WHERE status_key IS NULL';
    EXECUTE 'ALTER TABLE public.excluded_statuses DROP COLUMN status';
  END IF;
END;
$$;

-- Align metadata for status_key column.
DO $$
DECLARE
  has_status_key BOOLEAN := FALSE;
  null_exists BOOLEAN := FALSE;
BEGIN
  SELECT EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'excluded_statuses'
              AND column_name = 'status_key'
         )
    INTO has_status_key;

  IF has_status_key THEN
    SELECT EXISTS (
             SELECT 1
               FROM public.excluded_statuses
              WHERE status_key IS NULL
           )
      INTO null_exists;

    IF NOT null_exists THEN
      EXECUTE 'ALTER TABLE public.excluded_statuses ALTER COLUMN status_key SET NOT NULL';
    END IF;
  END IF;
END;
$$;

-- Guarantee created_at column presence and defaults.
ALTER TABLE public.excluded_statuses
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

UPDATE public.excluded_statuses
   SET created_at = NOW()
 WHERE created_at IS NULL;

ALTER TABLE public.excluded_statuses
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN created_at SET DEFAULT NOW();

-- Ensure status_key is the primary key.
DO $$
DECLARE
  pk_name TEXT;
  pk_columns TEXT[];
BEGIN
  SELECT con.conname,
         ARRAY_AGG(att.attname ORDER BY cols.ord)
    INTO pk_name, pk_columns
    FROM pg_constraint con
    JOIN pg_class cls ON cls.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = cls.relnamespace
    JOIN unnest(con.conkey) WITH ORDINALITY AS cols(attnum, ord) ON TRUE
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = cols.attnum
   WHERE con.contype = 'p'
     AND ns.nspname = 'public'
     AND cls.relname = 'excluded_statuses'
   GROUP BY con.conname;

  IF pk_name IS NULL THEN
    EXECUTE 'ALTER TABLE public.excluded_statuses ADD PRIMARY KEY (status_key)';
  ELSIF array_length(pk_columns, 1) != 1 OR pk_columns[1] <> 'status_key' THEN
    EXECUTE format('ALTER TABLE public.excluded_statuses DROP CONSTRAINT %I', pk_name);
    EXECUTE 'ALTER TABLE public.excluded_statuses ADD PRIMARY KEY (status_key)';
  END IF;
END;
$$;

-- Rebuild history table so it matches the base table structure.
DO $$
BEGIN
  PERFORM rebuild_history_table('excluded_statuses');
EXCEPTION
  WHEN undefined_function THEN
    NULL;
END;
$$;

COMMIT;
