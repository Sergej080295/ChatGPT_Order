BEGIN;

-- 1. Ensure crm_order_id column exists on orders.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'orders'
       AND column_name = 'crm_order_id'
  ) THEN
    ALTER TABLE public.orders
      ADD COLUMN crm_order_id TEXT;
  END IF;
END;
$$;

-- 2. Normalize crm_order_id type to TEXT.
DO $$
DECLARE
  col_type TEXT;
BEGIN
  SELECT data_type
    INTO col_type
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'orders'
     AND column_name = 'crm_order_id'
   LIMIT 1;

  IF col_type IS NULL OR col_type = 'text' THEN
    RETURN;
  END IF;

  ALTER TABLE public.orders
    ALTER COLUMN crm_order_id TYPE TEXT
    USING crm_order_id::text;
END;
$$;

-- 3. Remove duplicate crm_order_id values before enforcing uniqueness.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'orders'
       AND column_name = 'crm_order_id'
  ) THEN
    WITH duplicates AS (
      SELECT id
        FROM (
          SELECT id,
                 ROW_NUMBER() OVER (PARTITION BY crm_order_id ORDER BY id) AS rn
            FROM public.orders
           WHERE crm_order_id IS NOT NULL
        ) ranked
       WHERE ranked.rn > 1
    )
    UPDATE public.orders AS o
       SET crm_order_id = NULL
      FROM duplicates d
     WHERE o.id = d.id;
  END IF;
END;
$$;

-- 4. Recreate uniqueness constraint for crm_order_id.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'orders'
       AND column_name = 'crm_order_id'
  ) THEN
    BEGIN
      ALTER TABLE public.orders
        DROP CONSTRAINT IF EXISTS orders_crm_order_id_key;
    EXCEPTION
      WHEN undefined_object THEN
        NULL;
    END;

    BEGIN
      ALTER TABLE public.orders
        ADD CONSTRAINT orders_crm_order_id_key UNIQUE (crm_order_id);
    EXCEPTION
      WHEN duplicate_object THEN
        NULL;
    END;
  END IF;
END;
$$;

-- 5. Ensure history table has crm_order_id column.
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
         AND column_name = 'crm_order_id'
    ) THEN
      ALTER TABLE public.orders_hist
        ADD COLUMN crm_order_id TEXT;
    ELSE
      ALTER TABLE public.orders_hist
        ALTER COLUMN crm_order_id TYPE TEXT
        USING crm_order_id::text;
    END IF;
  END IF;
END;
$$;

-- 6. Backfill history entries with values from orders when missing.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'orders_hist'
       AND column_name = 'crm_order_id'
  ) THEN
    UPDATE public.orders_hist AS h
       SET crm_order_id = o.crm_order_id
      FROM public.orders AS o
     WHERE h.id = o.id
       AND h.crm_order_id IS NULL
       AND o.crm_order_id IS NOT NULL;
  END IF;
END;
$$;

COMMIT;
