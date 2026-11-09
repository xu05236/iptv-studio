-- Historical drift repair. On this deployment 0014 was applied by hand before
-- the migration table tracked it, so `d1_migrations` was missing the row and
-- later runs tried to re-apply it (duplicate column name). Fresh databases
-- apply 0014 normally and already have the row, so this INSERT is a no-op here;
-- drifted databases get it backfilled once, after which the old
-- `db:mark-drift` deploy step is no longer needed.
INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0014_run_task_id.sql');
