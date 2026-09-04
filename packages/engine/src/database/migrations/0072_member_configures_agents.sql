-- The member/admin line moves: a MEMBER configures an agent end to end,
-- credentials included.
--
-- Requiring `admin` to attach a channel or set an API key means granting `admin`
-- to everyone who ships an agent, which is not a role boundary at all. The
-- exposure is narrower than the key names suggest: `GET
-- /api/instances/:slug/secrets` returns key NAMES only (`listSecretKeys`), so a
-- secret is write-only through the API.
--
-- `agent.export:read` returns to member for the same reason it left. 0051 seeded
-- it there; a later change raised it to admin because the export bundle enumerates
-- secret key names, which `agent.secret:read` at member dissolves — the bundle
-- carries no secret values and strips credential-like channel config.
--
-- Admin keeps DESTRUCTION, GOVERNANCE and FORENSICS: `agent:delete`,
-- `agent.governance:write`, `conversation:delete`, `audit_log:read`.
--
-- Idempotent via the (role_id, permission) primary key.
INSERT INTO "role_permissions" ("role_id", "permission")
  SELECT r.id, p.permission FROM "roles" r
  CROSS JOIN (VALUES
    ('agent.secret:read'),('agent.secret:write'),('agent.export:read')
  ) AS p(permission)
  -- `organization_id IS NULL` is what makes a system role GLOBAL (see the
  -- docblock in authz/role.schema.ts); `is_system = true` alone would also match
  -- a future per-org system role and silently over-grant it.
  WHERE r."is_system" = true AND r."organization_id" IS NULL AND r."key" = 'member'
ON CONFLICT DO NOTHING;
