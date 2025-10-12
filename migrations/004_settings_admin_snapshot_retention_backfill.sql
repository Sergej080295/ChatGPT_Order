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
  need_defaults BOOLEAN := EXISTS (
    SELECT 1
      FROM settings_admin
     WHERE allow_force_overwrite IS NULL
        OR snapshot_retention IS NULL
        OR updated_at IS NULL
  );
  need_row BOOLEAN := NOT EXISTS (
    SELECT 1 FROM settings_admin WHERE id = 1
  );
  need_reset BOOLEAN := EXISTS (
    SELECT 1
      FROM settings_admin
     WHERE id = 1
       AND (
         allow_force_overwrite IS DISTINCT FROM FALSE
         OR snapshot_retention IS DISTINCT FROM 50
       )
  );
  new_rev BIGINT;
BEGIN
  IF need_defaults OR need_row OR need_reset THEN
    SELECT nextval('revisions_rev_seq') INTO new_rev;
    PERFORM set_config('app.rev', new_rev::TEXT, true);

    UPDATE settings_admin
       SET allow_force_overwrite = COALESCE(allow_force_overwrite, FALSE),
           snapshot_retention = COALESCE(snapshot_retention, 50),
           updated_at = COALESCE(updated_at, NOW())
     WHERE allow_force_overwrite IS NULL
        OR snapshot_retention IS NULL
        OR updated_at IS NULL;

    INSERT INTO settings_admin (id, allow_force_overwrite, snapshot_retention, updated_at)
    VALUES (1, FALSE, 50, NOW())
    ON CONFLICT (id) DO UPDATE
          SET allow_force_overwrite = EXCLUDED.allow_force_overwrite,
              snapshot_retention = EXCLUDED.snapshot_retention,
              updated_at = NOW()
        WHERE (
          settings_admin.allow_force_overwrite IS DISTINCT FROM EXCLUDED.allow_force_overwrite
          OR settings_admin.snapshot_retention IS DISTINCT FROM EXCLUDED.snapshot_retention
        );

    INSERT INTO revisions (rev, actor, source, note)
    VALUES (new_rev, 'system', 'migration', 'ensure settings_admin defaults')
    ON CONFLICT (rev) DO NOTHING;

    PERFORM set_config('app.rev', '', true);
    PERFORM set_config('app.rev', NULL::text, true);
  END IF;
END;
$$;

ALTER TABLE settings_admin
  ALTER COLUMN allow_force_overwrite SET NOT NULL,
  ALTER COLUMN snapshot_retention SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL;

COMMIT;
