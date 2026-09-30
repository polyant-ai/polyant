ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "web_context_field_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL;
