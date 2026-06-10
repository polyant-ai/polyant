CREATE TABLE IF NOT EXISTS "instance_hooks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "instance_id" uuid NOT NULL REFERENCES "instances"("id") ON DELETE CASCADE,
  "event" varchar(32) NOT NULL,
  "action_type" varchar(32) NOT NULL DEFAULT 'tool',
  "action_config" jsonb NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "position" integer NOT NULL DEFAULT 0,
  "timeout_ms" integer NOT NULL DEFAULT 10000,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_instance_hooks_instance_event" ON "instance_hooks" ("instance_id", "event");
