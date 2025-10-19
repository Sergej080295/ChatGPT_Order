BEGIN;

CREATE TABLE planner_settings_all (
  scope TEXT NOT NULL,
  path TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  value_type TEXT NOT NULL,
  value_text TEXT,
  value_numeric NUMERIC,
  value_boolean BOOLEAN,
  value_timestamp TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT,
  PRIMARY KEY (scope, path, ordinal)
);

INSERT INTO planner_settings_all (scope, path, ordinal, value_type, value_text, value_numeric, value_boolean, value_timestamp, updated_at, updated_by)
SELECT 'general', path, ordinal, value_type, value_text, value_numeric, value_boolean, value_timestamp, updated_at, updated_by
  FROM planner_settings;

INSERT INTO planner_settings_all (scope, path, ordinal, value_type, value_text, value_numeric, value_boolean, value_timestamp, updated_at, updated_by)
SELECT 'preferences', key, 0, 'boolean', NULL, NULL, value, NULL, updated_at, updated_by
  FROM planner_preferences;

DROP TABLE IF EXISTS planner_settings;
DROP TABLE IF EXISTS planner_preferences;

ALTER TABLE planner_settings_all RENAME TO planner_settings;

CREATE INDEX planner_settings_scope_path_idx ON planner_settings (scope, path);

COMMIT;
