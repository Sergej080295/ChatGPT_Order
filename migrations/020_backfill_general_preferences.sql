BEGIN;

DELETE FROM planner_general_settings
 WHERE path LIKE 'preferences/%';

WITH latest_rev AS (
  SELECT s.rev
    FROM planner_snapshots AS s
   ORDER BY s.rev DESC, s.created_at DESC
   LIMIT 1
)
INSERT INTO planner_general_settings (path, value_type, value_text, value_numeric, value_boolean, ordinal, updated_by)
SELECT
  'preferences/' || e.path AS path,
  e.value_type,
  e.value_text,
  e.value_numeric,
  e.value_boolean,
  e.ordinal,
  'migration-020' AS updated_by
FROM planner_snapshot_entries AS e
JOIN latest_rev lr ON lr.rev = e.rev
WHERE e.category = 'meta'
  AND e.path = ANY(ARRAY[
    'autosaveOn',
    'autoOptimizeOn',
    'cascadeReadyOn',
    'shiftOnProgress',
    'priorityChangeLoggingOn',
    'routeDateChangeLoggingOn',
    'notificationsMuted'
  ])
ON CONFLICT (path, ordinal) DO UPDATE
  SET value_type = EXCLUDED.value_type,
      value_text = EXCLUDED.value_text,
      value_numeric = EXCLUDED.value_numeric,
      value_boolean = EXCLUDED.value_boolean,
      updated_at = NOW(),
      updated_by = EXCLUDED.updated_by;

COMMIT;
