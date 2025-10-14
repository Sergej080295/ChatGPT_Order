DO $$
DECLARE
  has_table BOOLEAN := FALSE;
BEGIN
  SELECT TRUE
    INTO has_table
    FROM information_schema.tables
   WHERE table_schema = 'public'
     AND table_name = 'settings_autoweight'
   LIMIT 1;

  IF NOT has_table THEN
    RETURN;
  END IF;

  BEGIN
    EXECUTE 'ALTER TABLE settings_autoweight ALTER COLUMN percent SET DEFAULT 5';
  EXCEPTION WHEN undefined_column THEN
    -- ignore if column missing
  END;

  BEGIN
    EXECUTE 'ALTER TABLE settings_autoweight ALTER COLUMN minimum_hours SET DEFAULT 0.25';
  EXCEPTION WHEN undefined_column THEN
    -- ignore if column missing
  END;

  INSERT INTO settings_autoweight (id, enabled, percent, minimum_hours, updated_at)
  VALUES (1, TRUE, 5, 0.25, NOW())
  ON CONFLICT (id) DO UPDATE
    SET enabled = COALESCE(settings_autoweight.enabled, EXCLUDED.enabled),
        percent = CASE
                    WHEN settings_autoweight.percent IS NULL OR settings_autoweight.percent = 0
                      THEN EXCLUDED.percent
                    ELSE settings_autoweight.percent
                  END,
        minimum_hours = CASE
                          WHEN settings_autoweight.minimum_hours IS NULL OR settings_autoweight.minimum_hours = 0
                            THEN EXCLUDED.minimum_hours
                          ELSE settings_autoweight.minimum_hours
                        END,
        updated_at = NOW();

END
$$;
