BEGIN;

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
END;
$$;

ALTER TABLE settings_admin
  ALTER COLUMN allow_force_overwrite SET NOT NULL,
  ALTER COLUMN snapshot_retention SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;

COMMIT;
