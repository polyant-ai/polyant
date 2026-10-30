-- What becomes of text a model writes alongside a tool call: "discard", "progress"
-- or "reply". NULL keeps the behaviour from before the setting existed.
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "intermediate_text" text;
ALTER TABLE "instances" DROP CONSTRAINT IF EXISTS "instances_intermediate_text_check";
ALTER TABLE "instances" ADD CONSTRAINT "instances_intermediate_text_check"
  CHECK ("intermediate_text" IS NULL OR "intermediate_text" IN ('discard', 'progress', 'reply'));
