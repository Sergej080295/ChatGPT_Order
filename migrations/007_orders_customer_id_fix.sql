BEGIN;

-- 1. Гарантируем наличие колонки customer_id в основной таблице заказов.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'orders'
       AND column_name = 'customer_id'
  ) THEN
    ALTER TABLE public.orders
      ADD COLUMN customer_id BIGINT;
  END IF;
END;
$$;

-- 2. Приводим тип customer_id к BIGINT.
DO $$
DECLARE
  col_type TEXT;
BEGIN
  SELECT data_type
    INTO col_type
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'orders'
     AND column_name = 'customer_id'
   LIMIT 1;

  IF col_type IS NULL OR col_type = 'bigint' THEN
    RETURN;
  END IF;

  IF col_type IN ('integer', 'smallint') THEN
    ALTER TABLE public.orders
      ALTER COLUMN customer_id TYPE BIGINT
      USING customer_id::bigint;
  ELSE
    ALTER TABLE public.orders
      ALTER COLUMN customer_id TYPE BIGINT
      USING CASE
        WHEN customer_id IS NULL THEN NULL
        WHEN (customer_id::text) ~ '^[0-9]+$' THEN (customer_id::text)::bigint
        ELSE NULL
      END;
  END IF;
END;
$$;

-- 3. Добавляем или переопределяем ограничение внешнего ключа на customers.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'orders'
       AND column_name = 'customer_id'
  ) THEN
    BEGIN
      ALTER TABLE public.orders
        DROP CONSTRAINT IF EXISTS orders_customer_id_fkey;
      ALTER TABLE public.orders
        ADD CONSTRAINT orders_customer_id_fkey
        FOREIGN KEY (customer_id)
        REFERENCES public.customers(id)
        ON DELETE SET NULL;
    EXCEPTION
      WHEN undefined_table THEN
        NULL;
      WHEN duplicate_object THEN
        NULL;
    END;
  END IF;
END;
$$;

-- 4. Пытаемся восстановить связи по доступным колонкам.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'orders'
       AND column_name = 'customer_id'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'orders'
         AND column_name = 'customer_crm_id'
    ) THEN
      UPDATE public.orders AS o
         SET customer_id = c.id
        FROM public.customers AS c
       WHERE c.crm_id = o.customer_crm_id
         AND o.customer_crm_id IS NOT NULL
         AND o.customer_id IS DISTINCT FROM c.id;
    END IF;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'orders'
         AND column_name = 'customer_name'
    ) THEN
      UPDATE public.orders AS o
         SET customer_id = c.id
        FROM public.customers AS c
       WHERE lower(c.name) = lower(o.customer_name)
         AND o.customer_id IS NULL;
    END IF;
  END IF;
END;
$$;

-- 5. Добавляем колонку в таблицу истории заказов.
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
         AND column_name = 'customer_id'
    ) THEN
      ALTER TABLE public.orders_hist
        ADD COLUMN customer_id BIGINT;
    ELSE
      ALTER TABLE public.orders_hist
        ALTER COLUMN customer_id TYPE BIGINT
        USING CASE
          WHEN customer_id IS NULL THEN NULL
          WHEN (customer_id::text) ~ '^[0-9]+$' THEN (customer_id::text)::bigint
          ELSE NULL
        END;
    END IF;
  END IF;
END;
$$;

-- 6. Для истории заполняем новые значения из основной таблицы, если возможно.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'orders_hist'
       AND column_name = 'customer_id'
  ) THEN
    UPDATE public.orders_hist AS h
       SET customer_id = o.customer_id
      FROM public.orders AS o
     WHERE h.id = o.id
       AND h.customer_id IS NULL
       AND o.customer_id IS NOT NULL;
  END IF;
END;
$$;

-- 7. Создаём индекс для ускорения связей по customer_id.
CREATE INDEX IF NOT EXISTS orders_customer_id_idx ON public.orders(customer_id);

COMMIT;
