-- A lease on a unit of background work (a Room's cycle, the daily housekeeping), so
-- that across replicas one process does it at a time. The expiry is set from the
-- database clock; an expired lease is free, and its work is taken up again by any
-- replica's next tick. `last_done_at` is when a periodic job last completed.
CREATE TABLE IF NOT EXISTS "work_leases" (
  "key" text PRIMARY KEY NOT NULL,
  "owner" text,
  "expires_at" timestamp with time zone,
  "last_done_at" timestamp with time zone
);

-- The lease owner that claimed a Room event. Only that owner completes it, and an
-- event whose owner no longer holds a live lease goes back to pending.
ALTER TABLE "event_backlog" ADD COLUMN IF NOT EXISTS "claimed_by" text;

-- The index the per-tick requeue reads is built concurrently by 0120.
