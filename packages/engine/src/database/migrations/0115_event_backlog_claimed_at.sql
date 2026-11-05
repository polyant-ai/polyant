-- When a Room event was claimed. An event a process of the previous release
-- claimed carries no owner, so whether its cycle still runs cannot be told from
-- a lease: the engine stamps it the first time it sees it in processing and puts
-- it back to pending only after a lease's lifetime.
ALTER TABLE "event_backlog" ADD COLUMN IF NOT EXISTS "claimed_at" timestamp with time zone;
