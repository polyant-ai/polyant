-- The request path of a turn: every model call, hook run and tool run linked to
-- the assistant message, with start times, the moment the reply was sent, and
-- (with the agent's debug flag) the raw exchange with the provider. Nullable
-- columns only: catalog changes, no rewrite of the busy tables.
ALTER TABLE "ai_logs" ADD COLUMN IF NOT EXISTS "message_id" uuid;
--> statement-breakpoint
ALTER TABLE "ai_logs" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "ai_logs" ADD COLUMN IF NOT EXISTS "origin_name" text;
--> statement-breakpoint
ALTER TABLE "ai_logs" ADD COLUMN IF NOT EXISTS "parent_ref" text;
--> statement-breakpoint
ALTER TABLE "hook_executions" ADD COLUMN IF NOT EXISTS "message_id" uuid;
--> statement-breakpoint
ALTER TABLE "hook_executions" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "pipeline_traces" ADD COLUMN IF NOT EXISTS "turn_started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "pipeline_traces" ADD COLUMN IF NOT EXISTS "reply_sent_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "pipeline_traces" ADD COLUMN IF NOT EXISTS "delivered_text" text;
--> statement-breakpoint
ALTER TABLE "pipeline_traces" ADD COLUMN IF NOT EXISTS "intermediate_text" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_exchanges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "ai_log_id" uuid NOT NULL,
  "message_id" uuid,
  "conversation_id" text,
  "instance_id" text,
  "step_index" integer NOT NULL,
  "attempt" integer DEFAULT 1 NOT NULL,
  "status" integer,
  "request" jsonb,
  "response" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_model_exchanges_ai_log" ON "model_exchanges" ("ai_log_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_model_exchanges_conversation" ON "model_exchanges" ("conversation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_model_exchanges_created" ON "model_exchanges" ("created_at");
