-- Six per-agent behaviours and two platform policies stop being deployment
-- configuration.
--
-- Every column is NULLABLE and NULL means "not set here", falling back to the
-- environment variable that used to be the only answer. That is what makes the
-- upgrade a no-op: an installation that changes nothing keeps the behaviour it
-- has, and each value moves the day someone sets it.

-- ── Per-agent ────────────────────────────────────────────────────────────────
-- These shape how ONE agent behaves, and two agents on the same installation
-- legitimately differ: an agent serving Italian customers and one serving German
-- customers want different datetime formatting, and a support agent and a
-- booking agent want different debounce windows.
ALTER TABLE "instances"
  ADD COLUMN IF NOT EXISTS "datetime_timezone" text,
  ADD COLUMN IF NOT EXISTS "datetime_locale" text,
  ADD COLUMN IF NOT EXISTS "dedup_similarity_threshold" real,
  ADD COLUMN IF NOT EXISTS "message_soft_debounce_ms" integer,
  ADD COLUMN IF NOT EXISTS "message_typing_delay_ms" integer,
  ADD COLUMN IF NOT EXISTS "message_max_restarts" integer;

-- A similarity is a cosine score, so the only meaningful range is [0, 1]. A
-- value outside it makes every memory a duplicate or none of them, silently.
ALTER TABLE "instances"
  ADD CONSTRAINT "instances_dedup_similarity_threshold_range"
  CHECK ("dedup_similarity_threshold" IS NULL
         OR ("dedup_similarity_threshold" >= 0 AND "dedup_similarity_threshold" <= 1));

-- Milliseconds and a restart count: zero is a legitimate value for all three
-- (no debounce, no typing delay, no restart), negative is not.
ALTER TABLE "instances"
  ADD CONSTRAINT "instances_message_timings_non_negative"
  CHECK (("message_soft_debounce_ms" IS NULL OR "message_soft_debounce_ms" >= 0)
     AND ("message_typing_delay_ms" IS NULL OR "message_typing_delay_ms" >= 0)
     AND ("message_max_restarts" IS NULL OR "message_max_restarts" >= 0));

-- ── Platform ─────────────────────────────────────────────────────────────────
-- Policies of the installation, which is a tier that had no table at all: the
-- two values below decide how much history the deployment keeps and how many
-- live streams one person may hold, and an administrator should be able to
-- change either without a redeploy.
--
-- ONE row, enforced by the primary key: `id` is a boolean that may only be true,
-- so a second row is a constraint violation rather than a silent second opinion
-- about the same policy.
CREATE TABLE IF NOT EXISTS "platform_settings" (
  "id" boolean PRIMARY KEY DEFAULT true,
  "analytics_retention_days" integer,
  "sse_max_connections_per_user" integer,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "platform_settings_single_row" CHECK ("id"),
  CONSTRAINT "platform_settings_analytics_retention_days_positive"
    CHECK ("analytics_retention_days" IS NULL OR "analytics_retention_days" > 0),
  CONSTRAINT "platform_settings_sse_max_connections_per_user_positive"
    CHECK ("sse_max_connections_per_user" IS NULL OR "sse_max_connections_per_user" > 0)
);

-- The row exists from the start, with both policies unset. A resolver that has
-- to cope with "no row yet" AND "row with NULLs" answers the same question
-- twice; seeding it leaves one shape.
INSERT INTO "platform_settings" ("id") VALUES (true) ON CONFLICT DO NOTHING;
