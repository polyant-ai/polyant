-- What a service call was for (title, summary, memory, ...), so service spend can
-- be grouped by it. Nullable without a default: a catalog-only change, and every
-- existing row and every conversation call keeps NULL.
ALTER TABLE "ai_logs" ADD COLUMN IF NOT EXISTS "purpose" text;
