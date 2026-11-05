-- The per-tick requeue of Room events reads only the rows in processing. Built
-- concurrently, outside a transaction, so the backlog keeps taking events.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_event_backlog_processing"
  ON "event_backlog" ("instance_id") WHERE "status" = 'processing';
