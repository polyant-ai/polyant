-- Per-task run deadline for the scheduler reaper.
--
-- `markRunning` sets last_run_status='running' and nothing ever cleared it: a process
-- killed mid-run (deploy, OOM, node crash) left the row 'running' forever, and
-- `getDueTasks` excludes those rows — so the task went silent with no error anywhere.
-- The reaper needs a per-task deadline to tell "still working" from "never coming back";
-- NULL falls back to config.scheduler.defaultMaxRunMs.
ALTER TABLE "scheduled_tasks" ADD COLUMN IF NOT EXISTS "max_run_ms" integer;

-- The reaper and the startup recovery both scan for rows stuck in 'running', ordered by
-- how long they have been there. Without this index that scan is a full table scan on
-- every tick.
CREATE INDEX IF NOT EXISTS "idx_scheduled_tasks_running"
  ON "scheduled_tasks" ("updated_at")
  WHERE "last_run_status" = 'running';
