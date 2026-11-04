-- A running task's lease: until when the process running it vouches for it, renewed
-- as the run goes on. A run whose lease expired is taken as interrupted by any
-- replica's tick, without counting a failure. NULL for a row claimed before leases.
ALTER TABLE "scheduled_tasks" ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamp with time zone;
