-- The daily housekeeping drops the webhook delivery keys past their window for
-- every source, by age. Claiming a key no longer purges its source first, so a
-- source that stops receiving events no longer keeps its keys for good.
CREATE INDEX IF NOT EXISTS "idx_webhook_deliveries_received" ON "webhook_deliveries" ("received_at");
