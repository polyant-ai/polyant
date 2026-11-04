-- Indexes of the append-only log tables, fitted to what reads them.
--
-- Two single-column indexes are the leading column of a composite index on the same
-- table, which serves every query they served; each cost a B-tree write on every
-- insert into the two most-written tables. The last migration of the release (0118)
-- drops them.

-- The daily cleanup deletes the rows older than the retention window. Without an
-- index on that time it scanned the whole table each night. B-tree rather than BRIN:
-- the cleanup frees the oldest pages and new rows reuse them, so the physical order
-- a BRIN index relies on does not last.
CREATE INDEX IF NOT EXISTS "idx_tool_audit_created" ON "tool_audit_logs" ("created_at");
CREATE INDEX IF NOT EXISTS "idx_hook_executions_created" ON "hook_executions" ("created_at");
CREATE INDEX IF NOT EXISTS "idx_task_runs_started" ON "scheduled_task_runs" ("started_at");
CREATE INDEX IF NOT EXISTS "idx_event_backlog_completed_created"
  ON "event_backlog" ("created_at") WHERE "status" = 'completed';
