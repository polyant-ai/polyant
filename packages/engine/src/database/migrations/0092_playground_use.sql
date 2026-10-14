-- Testing an agent from the panel's Playground gets its own permission,
-- `agent.playground:use`, held by every built-in role including viewer: using the
-- Playground is not editing the agent. The route is session-gated and needs no
-- agent key, so this is the only thing standing between a panel user and a turn.
--
-- Idempotent via the (role_id, permission) primary key. `organization_id IS NULL`
-- keeps it to the GLOBAL system roles (see authz/role.schema.ts).
INSERT INTO "role_permissions" ("role_id", "permission")
  SELECT r.id, 'agent.playground:use' FROM "roles" r
  WHERE r."is_system" = true AND r."organization_id" IS NULL
    AND r."key" IN ('owner', 'admin', 'member', 'viewer')
ON CONFLICT DO NOTHING;
