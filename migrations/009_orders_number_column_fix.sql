BEGIN;

-- 1. Ensure the orders table exposes the number column as TEXT.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'orders'
       AND column_name = 'number'
  ) THEN
    ALTER TABLE public.orders
      ADD COLUMN number TEXT;
  END IF;
END;
$$;

DO $$
DECLARE
  col_type TEXT;
BEGIN
  SELECT data_type
    INTO col_type
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'orders'
     AND column_name = 'number'
   LIMIT 1;

  IF col_type IS NOT NULL AND col_type <> 'text' THEN
    ALTER TABLE public.orders
      ALTER COLUMN number TYPE TEXT
      USING number::text;
  END IF;
END;
$$;

-- 2. Backfill number from legacy columns if available.
DO $$
DECLARE
  has_name BOOLEAN;
  has_order_number BOOLEAN;
BEGIN
  SELECT EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'orders'
              AND column_name = 'name'
         )
    INTO has_name;

  SELECT EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'orders'
              AND column_name = 'order_number'
         )
    INTO has_order_number;

  IF has_name THEN
    EXECUTE 'UPDATE public.orders SET number = name WHERE number IS NULL AND name IS NOT NULL';
  END IF;

  IF has_order_number THEN
    EXECUTE 'UPDATE public.orders SET number = order_number WHERE number IS NULL AND order_number IS NOT NULL';
  END IF;
END;
$$;

UPDATE public.orders
   SET number = crm_order_id
 WHERE number IS NULL
   AND crm_order_id IS NOT NULL;

UPDATE public.orders
   SET number = id::text
 WHERE number IS NULL;

ALTER TABLE public.orders
  ALTER COLUMN number SET NOT NULL;

-- 3. Align orders history table with the new column.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = 'orders_hist'
  ) THEN
    IF NOT EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'orders_hist'
         AND column_name = 'number'
    ) THEN
      ALTER TABLE public.orders_hist
        ADD COLUMN number TEXT;
    ELSE
      ALTER TABLE public.orders_hist
        ALTER COLUMN number TYPE TEXT
        USING number::text;
    END IF;

    -- Copy legacy values when orders_hist stored them under a different column.
    BEGIN
      IF EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'orders_hist'
           AND column_name = 'name'
      ) THEN
        EXECUTE 'UPDATE public.orders_hist SET number = name WHERE number IS NULL AND name IS NOT NULL';
      END IF;
    EXCEPTION
      WHEN undefined_column THEN
        NULL;
    END;

    UPDATE public.orders_hist AS h
       SET number = o.number
      FROM public.orders AS o
     WHERE h.id = o.id
       AND o.number IS NOT NULL
       AND (h.number IS NULL OR h.number = '');
  END IF;
END;
$$;

COMMIT;
