-- An OAuth MCP server can authorize one account for the whole agent: an admin
-- connects it from the panel and every conversation uses it. The tokens live
-- next to the server they belong to, so deleting the server or the agent
-- removes them, and stay out of `config`, which the panel reads back and the
-- export copies.
ALTER TABLE "instance_mcp_servers" ADD COLUMN IF NOT EXISTS "shared_tokens" text;
ALTER TABLE "instance_mcp_servers" ADD COLUMN IF NOT EXISTS "shared_connected_at" timestamp with time zone;
ALTER TABLE "instance_mcp_servers" ADD COLUMN IF NOT EXISTS "shared_connected_by" uuid;
