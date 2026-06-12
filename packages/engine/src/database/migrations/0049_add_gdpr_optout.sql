ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "optout_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "optout_stop_keywords" jsonb DEFAULT '["STOP"]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "optout_resume_keywords" jsonb DEFAULT '["START"]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "optout_closing_message" text;
--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "optout_resume_message" text;
--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "optout_inject_prompt_hint" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_optouts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "instance_id" uuid NOT NULL,
  "channel_type" text NOT NULL,
  "channel_id" text NOT NULL,
  "status" text NOT NULL,
  "source" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "contact_optouts_instance_channel_uq" UNIQUE("instance_id","channel_type","channel_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "contact_optouts" ADD CONSTRAINT "contact_optouts_instance_id_instances_id_fk"
    FOREIGN KEY ("instance_id") REFERENCES "instances"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_optouts_instance_status_idx" ON "contact_optouts" ("instance_id","status");
