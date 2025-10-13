BEGIN;

-- Ensure settings_admin has explicit limits columns for admin history settings.
ALTER TABLE settings_admin
  ADD COLUMN IF NOT EXISTS history_limit INTEGER,
  ADD COLUMN IF NOT EXISTS history_daily_limit INTEGER;

UPDATE settings_admin
   SET history_limit = COALESCE(history_limit, 50);

UPDATE settings_admin
   SET history_daily_limit = CASE
     WHEN history_daily_limit IS NULL THEN 3
     WHEN history_limit IS NOT NULL AND history_daily_limit > history_limit THEN history_limit
     WHEN history_daily_limit < 1 THEN 1
     ELSE history_daily_limit
   END;

ALTER TABLE settings_admin
  ALTER COLUMN history_limit SET DEFAULT 50,
  ALTER COLUMN history_limit SET NOT NULL,
  ALTER COLUMN history_daily_limit SET DEFAULT 3,
  ALTER COLUMN history_daily_limit SET NOT NULL;

-- Align history table to the current structure (base columns + rev/op/changed_at).
ALTER TABLE settings_admin_hist
  ADD COLUMN IF NOT EXISTS history_limit INTEGER,
  ADD COLUMN IF NOT EXISTS history_daily_limit INTEGER;

UPDATE settings_admin_hist AS h
   SET history_limit = COALESCE(h.history_limit, a.history_limit, 50),
       history_daily_limit = CASE
         WHEN h.history_daily_limit IS NULL THEN LEAST(COALESCE(a.history_daily_limit, 3), COALESCE(a.history_limit, 50))
         WHEN a.history_limit IS NOT NULL AND h.history_daily_limit > a.history_limit THEN a.history_limit
         WHEN h.history_daily_limit < 1 THEN 1
         ELSE h.history_daily_limit
       END
  FROM settings_admin AS a
 WHERE a.id = h.id;

UPDATE settings_admin_hist
   SET history_limit = COALESCE(history_limit, 50);

UPDATE settings_admin_hist
   SET history_daily_limit = CASE
     WHEN history_daily_limit IS NULL THEN 3
     WHEN history_limit IS NOT NULL AND history_daily_limit > history_limit THEN history_limit
     WHEN history_daily_limit < 1 THEN 1
     ELSE history_daily_limit
   END;

ALTER TABLE settings_admin_hist
  ALTER COLUMN history_limit SET DEFAULT 50,
  ALTER COLUMN history_limit SET NOT NULL,
  ALTER COLUMN history_daily_limit SET DEFAULT 3,
  ALTER COLUMN history_daily_limit SET NOT NULL;

COMMIT;
