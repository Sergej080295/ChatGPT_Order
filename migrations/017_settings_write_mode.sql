BEGIN;

DO $$
BEGIN
  ALTER TABLE settings_admin ADD COLUMN write_mode TEXT NOT NULL DEFAULT 'both';
EXCEPTION
  WHEN duplicate_column THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE settings_admin_hist ADD COLUMN write_mode TEXT;
EXCEPTION
  WHEN duplicate_column THEN NULL;
END $$;

UPDATE settings_admin
   SET write_mode = CASE
       WHEN write_mode IN ('crm','planner','both') THEN write_mode
       ELSE 'both'
     END;

ALTER TABLE settings_admin ALTER COLUMN write_mode SET DEFAULT 'both';
ALTER TABLE settings_admin ALTER COLUMN write_mode SET NOT NULL;

UPDATE settings_admin_hist
   SET write_mode = CASE
       WHEN write_mode IN ('crm','planner','both') THEN write_mode
       ELSE COALESCE(write_mode, 'both')
     END;

COMMIT;
