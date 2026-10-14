-- Web becomes a channel: an `instance_channels` row of type 'web' says whether
-- the agent's public HTTP endpoints (/v1/chat/completions, chat/stream) answer.
-- A missing row means off.

-- 1. The seeded demo-agent (0035, auth off) is removed when nobody ever used it,
--    so a fresh install ends up with no agent reachable without a decision.
--    "Never used" means all of: no conversation, memory, knowledge document,
--    scheduled task or secret under its slug/id, and a row never updated after
--    its creation (the seed inserts it in one statement, so the two timestamps
--    are equal; any save through the API moves updated_at). Dependent rows keyed
--    by the instance id (prompts, tools, skills, channels, ...) go with it
--    through their ON DELETE CASCADE foreign keys. A demo-agent that fails any
--    test stays, and is treated like every other existing agent below.
DELETE FROM "instances" i
WHERE i."slug" = 'demo-agent'
  AND i."updated_at" <= i."created_at" + interval '1 second'
  AND NOT EXISTS (SELECT 1 FROM "conversations" c WHERE c."instance_id" = i."slug")
  AND NOT EXISTS (SELECT 1 FROM "memories" m WHERE m."instance_id" = i."slug")
  AND NOT EXISTS (SELECT 1 FROM "knowledge_documents" k WHERE k."instance_id" = i."slug")
  AND NOT EXISTS (SELECT 1 FROM "scheduled_tasks" t WHERE t."instance_id" = i."slug")
  AND NOT EXISTS (SELECT 1 FROM "instance_secrets" s WHERE s."instance_id" = i."id");
--> statement-breakpoint

-- 2. Every agent that exists now is reachable today, so it keeps its endpoint:
--    Web on, with the auth_enabled it already has. Agents created later get an
--    explicit row with Web off.
INSERT INTO "instance_channels" ("instance_id", "channel_type", "enabled", "config")
SELECT i."id", 'web', true, ''
FROM "instances" i
ON CONFLICT ("instance_id", "channel_type") DO NOTHING;
