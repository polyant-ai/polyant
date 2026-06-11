CREATE TABLE IF NOT EXISTS "hook_executions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "instance_id" text NOT NULL,
  "conversation_id" text NOT NULL,
  "hook_id" uuid NOT NULL,
  "event" varchar(32) NOT NULL,
  "action_type" varchar(32) NOT NULL,
  "tool_name" text NOT NULL,
  "success" boolean NOT NULL,
  "error" text,
  "duration_ms" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hook_executions_conversation" ON "hook_executions" ("conversation_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hook_executions_instance" ON "hook_executions" ("instance_id");
