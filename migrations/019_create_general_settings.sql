BEGIN;

CREATE TABLE IF NOT EXISTS planner_general_settings (
  path TEXT NOT NULL,
  value_type TEXT NOT NULL CHECK (value_type IN ('object','array','string','number','boolean','null')),
  value_text TEXT,
  value_numeric DOUBLE PRECISION,
  value_boolean BOOLEAN,
  ordinal INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT,
  PRIMARY KEY (path, ordinal)
);

CREATE INDEX IF NOT EXISTS planner_general_settings_path_pattern_idx
  ON planner_general_settings (path text_pattern_ops);

WITH latest_rev AS (
  SELECT MAX(rev) AS rev
    FROM planner_snapshots
)
INSERT INTO planner_general_settings (path, value_type, value_text, value_numeric, value_boolean, ordinal, updated_by)
SELECT
  regexp_replace(e.path, '^meta/settings/', '') AS path,
  e.value_type,
  e.value_text,
  e.value_numeric,
  e.value_boolean,
  e.ordinal,
  'migration-019' AS updated_by
FROM planner_snapshot_entries AS e
JOIN latest_rev lr ON lr.rev = e.rev
WHERE lr.rev IS NOT NULL
  AND e.category = 'state'
  AND e.path LIKE 'meta/settings/%'
ON CONFLICT (path, ordinal) DO NOTHING;

COMMIT;
