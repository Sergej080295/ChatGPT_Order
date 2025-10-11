BEGIN;

ALTER TABLE settings_admin
  ADD COLUMN IF NOT EXISTS allow_force_overwrite BOOLEAN,
  ADD COLUMN IF NOT EXISTS snapshot_retention INTEGER,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

UPDATE settings_admin
   SET allow_force_overwrite = FALSE
 WHERE allow_force_overwrite IS NULL;

UPDATE settings_admin
   SET snapshot_retention = 50
 WHERE snapshot_retention IS NULL;

UPDATE settings_admin
   SET updated_at = NOW()
 WHERE updated_at IS NULL;

ALTER TABLE settings_admin
  ALTER COLUMN allow_force_overwrite SET DEFAULT FALSE,
  ALTER COLUMN allow_force_overwrite SET NOT NULL,
  ALTER COLUMN snapshot_retention SET DEFAULT 50,
  ALTER COLUMN snapshot_retention SET NOT NULL,
  ALTER COLUMN updated_at SET DEFAULT NOW(),
  ALTER COLUMN updated_at SET NOT NULL;

INSERT INTO settings_admin (id, allow_force_overwrite, snapshot_retention, updated_at)
VALUES (1, FALSE, 50, NOW())
ON CONFLICT (id) DO UPDATE
      SET allow_force_overwrite = EXCLUDED.allow_force_overwrite,
          snapshot_retention = EXCLUDED.snapshot_retention,
          updated_at = NOW();

COMMIT;
