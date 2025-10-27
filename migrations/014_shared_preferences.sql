-- Ensure shared planner toggles persist in SQL and keep history.
DO $$
DECLARE
  constraint_exists BOOLEAN;
BEGIN
  -- Base table for shared planner preferences
  CREATE TABLE IF NOT EXISTS settings_shared_preferences (
    pref_key TEXT PRIMARY KEY,
    bool_value BOOLEAN NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- History table mirrors base columns plus revision metadata
  CREATE TABLE IF NOT EXISTS settings_shared_preferences_hist (
    pref_key TEXT NOT NULL,
    bool_value BOOLEAN NOT NULL,
    updated_at TIMESTAMPTZ,
    rev BIGINT NOT NULL,
    op CHAR(1) NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- Primary key for history table if it has not been defined yet
  SELECT TRUE
    INTO constraint_exists
    FROM information_schema.table_constraints
   WHERE table_schema = 'public'
     AND table_name = 'settings_shared_preferences_hist'
     AND constraint_name = 'settings_shared_preferences_hist_pk';

  IF NOT constraint_exists THEN
    ALTER TABLE settings_shared_preferences_hist
      ADD CONSTRAINT settings_shared_preferences_hist_pk PRIMARY KEY (pref_key, rev);
  END IF;

  -- Ensure trigger uses generic history handler
  PERFORM 1
    FROM pg_trigger
   WHERE tgname = 'settings_shared_preferences_history_trg'
     AND tgrelid = 'public.settings_shared_preferences'::regclass;

  IF NOT FOUND THEN
    CREATE TRIGGER settings_shared_preferences_history_trg
      AFTER INSERT OR UPDATE OR DELETE ON settings_shared_preferences
      FOR EACH ROW EXECUTE FUNCTION generic_history_trigger();
  END IF;

  -- Seed defaults so new installations have expected toggles enabled
  INSERT INTO settings_shared_preferences (pref_key, bool_value)
  VALUES
    ('autosaveOn', TRUE),
    ('autoOptimizeOn', TRUE),
    ('cascadeReadyOn', TRUE)
  ON CONFLICT (pref_key) DO NOTHING;
END
$$;
