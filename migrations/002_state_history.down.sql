BEGIN;

DROP INDEX IF EXISTS planner_state_history_created_idx;
DROP INDEX IF EXISTS planner_state_history_hash_idx;
DROP TABLE IF EXISTS planner_state_history;

COMMIT;
