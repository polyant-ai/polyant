ALTER TABLE "hook_executions" ADD COLUMN IF NOT EXISTS "args" jsonb;
--> statement-breakpoint
ALTER TABLE "hook_executions" ADD COLUMN IF NOT EXISTS "result" text;
