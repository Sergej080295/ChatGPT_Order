DO $$
DECLARE
  needs_base_update BOOLEAN := FALSE;
  needs_hist_update BOOLEAN := FALSE;
BEGIN
  SELECT TRUE
    INTO needs_base_update
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'settings_autoweight'
     AND column_name = 'percent'
     AND data_type <> 'numeric'
  LIMIT 1;

  IF needs_base_update THEN
    ALTER TABLE settings_autoweight
      ALTER COLUMN percent TYPE NUMERIC(10,2) USING percent::numeric(10,2);
    ALTER TABLE settings_autoweight
      ALTER COLUMN minimum_hours TYPE NUMERIC(10,2) USING minimum_hours::numeric(10,2);
    ALTER TABLE settings_autoweight
      ALTER COLUMN percent SET DEFAULT 0;
    ALTER TABLE settings_autoweight
      ALTER COLUMN minimum_hours SET DEFAULT 0;
  END IF;

  SELECT TRUE
    INTO needs_hist_update
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'settings_autoweight_hist'
     AND column_name = 'percent'
     AND data_type <> 'numeric'
  LIMIT 1;

  IF needs_hist_update THEN
    ALTER TABLE settings_autoweight_hist
      ALTER COLUMN percent TYPE NUMERIC(10,2) USING percent::numeric(10,2);
    ALTER TABLE settings_autoweight_hist
      ALTER COLUMN minimum_hours TYPE NUMERIC(10,2) USING minimum_hours::numeric(10,2);
  END IF;
END
$$;
