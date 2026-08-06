-- A2A (Agent2Agent) server exposure is opt-in per instance. Default false so no
-- instance is reachable as an A2A agent until an operator enables it.
-- Numbered 0074 (not 0073) to sit after the MCP feature's migration, which lands
-- on develop first; verify the number/journal idx against MCP before A2A merges.
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "a2a_enabled" boolean NOT NULL DEFAULT false;
