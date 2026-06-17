-- RBAC Stream 0 — tenancy schema foundation.
--
-- Creates the Organization > Workspace > (Agent) tenancy tables, the role
-- catalog with the full OSS permission matrix, the polymorphic role-binding
-- table with its scope-integrity trigger, and the management-plane authz audit
-- log. Seeds exactly one default organization + workspace and the four system
-- roles, then backfills every pre-existing user into the default org as Owner.
--
-- The whole file runs in a single transaction (the Drizzle postgres-js migrator
-- wraps each migration file in BEGIN/COMMIT). Every seed/backfill step is
-- idempotent (ON CONFLICT / NOT EXISTS) so re-running is a no-op, and a fresh
-- install with zero users performs no backfill.

CREATE TABLE IF NOT EXISTS "organizations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" varchar(100) NOT NULL,
  "name" varchar(255) NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspaces" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "slug" varchar(100) NOT NULL,
  "name" varchar(255) NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization_memberships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "roles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid,
  "key" varchar(50) NOT NULL,
  "name" varchar(100) NOT NULL,
  "is_system" boolean DEFAULT false NOT NULL,
  "level" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "role_permissions" (
  "role_id" uuid NOT NULL,
  "permission" varchar(100) NOT NULL,
  CONSTRAINT "role_permissions_role_id_permission_pk" PRIMARY KEY("role_id","permission")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "role_bindings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "role_id" uuid NOT NULL,
  "scope_type" varchar(20) NOT NULL,
  "scope_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "authz_audit_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "actor_user_id" uuid,
  "action" varchar(100) NOT NULL,
  "target_type" varchar(50),
  "target_id" uuid,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "ip_address" varchar(45),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Foreign keys (idempotent via duplicate_object guard).
DO $$ BEGIN
  ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "roles" ADD CONSTRAINT "roles_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk"
    FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_role_id_roles_id_fk"
    FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
-- Indexes.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_workspaces_org_slug" ON "workspaces" ("organization_id","slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workspaces_org" ON "workspaces" ("organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_org_memberships_org_user" ON "organization_memberships" ("organization_id","user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_memberships_user" ON "organization_memberships" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_org_memberships_org" ON "organization_memberships" ("organization_id");
--> statement-breakpoint
-- A partial unique index treats NULL organization_id (system roles) as a single
-- group, so 'owner' etc. cannot be seeded twice. Per-org custom roles get
-- their own uniqueness via the non-null index below.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_roles_system_key" ON "roles" ("key") WHERE "organization_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_roles_org_key" ON "roles" ("organization_id","key") WHERE "organization_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_roles_org" ON "roles" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_roles_system" ON "roles" ("is_system");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_role_permissions_role" ON "role_permissions" ("role_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_role_bindings_user_org" ON "role_bindings" ("user_id","organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_role_bindings_scope" ON "role_bindings" ("scope_type","scope_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_authz_audit_org_created" ON "authz_audit_logs" ("organization_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_authz_audit_actor" ON "authz_audit_logs" ("actor_user_id");
--> statement-breakpoint
-- users.is_platform_admin column.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_platform_admin" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- scope_id integrity trigger (design §7.3): organization-scope bindings must
-- point at their own org; workspace-scope bindings must point at a workspace
-- that belongs to the binding organization.
CREATE OR REPLACE FUNCTION check_role_binding_scope()
RETURNS trigger AS $$
BEGIN
  IF NEW.scope_type = 'organization' THEN
    IF NEW.scope_id <> NEW.organization_id THEN
      RAISE EXCEPTION 'scope_id must equal organization_id for organization scope';
    END IF;
  ELSIF NEW.scope_type = 'workspace' THEN
    IF NOT EXISTS (
      SELECT 1 FROM workspaces
      WHERE id = NEW.scope_id AND organization_id = NEW.organization_id
    ) THEN
      RAISE EXCEPTION 'scope_id must be a workspace belonging to the binding organization';
    END IF;
  ELSE
    RAISE EXCEPTION 'unknown scope_type: %', NEW.scope_type;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_role_binding_scope_check ON role_bindings;
--> statement-breakpoint
CREATE TRIGGER trg_role_binding_scope_check
BEFORE INSERT OR UPDATE ON role_bindings
FOR EACH ROW EXECUTE FUNCTION check_role_binding_scope();
--> statement-breakpoint
-- Seed: exactly one default organization.
INSERT INTO "organizations" ("slug", "name", "is_default")
  VALUES ('default', 'Default Organization', true)
  ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint
-- Seed: exactly one default workspace inside the default organization.
INSERT INTO "workspaces" ("organization_id", "slug", "name", "is_default")
  SELECT o.id, 'general', 'General', true
  FROM "organizations" o
  WHERE o.is_default = true
    AND NOT EXISTS (
      SELECT 1 FROM "workspaces" w WHERE w.organization_id = o.id AND w.slug = 'general'
    );
--> statement-breakpoint
-- Seed: the four OSS system roles (organization_id NULL, is_system true).
INSERT INTO "roles" ("organization_id", "key", "name", "is_system", "level") VALUES
  (NULL, 'owner',  'Owner',  true, 40),
  (NULL, 'admin',  'Admin',  true, 30),
  (NULL, 'member', 'Member', true, 20),
  (NULL, 'viewer', 'Viewer', true, 10)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Seed: full §4.2 permission matrix. Each role's grants are idempotent via the
-- (role_id, permission) primary key.
INSERT INTO "role_permissions" ("role_id", "permission")
  SELECT r.id, p.permission FROM "roles" r
  CROSS JOIN (VALUES
    ('agent:read'),('agent.channel:read'),('agent.skill:read'),('agent.tool:read'),
    ('agent.prompt:read'),('agent.room:read'),('agent.task:read'),('agent.knowledge:read'),
    ('agent.governance:read'),('conversation:read'),('memory:read'),('analytics:read'),
    ('skill.catalog:read'),('org:read')
  ) AS p(permission)
  WHERE r.is_system = true AND r.key = 'viewer'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission")
  SELECT r.id, p.permission FROM "roles" r
  CROSS JOIN (VALUES
    ('agent:read'),('agent.channel:read'),('agent.skill:read'),('agent.tool:read'),
    ('agent.prompt:read'),('agent.room:read'),('agent.task:read'),('agent.knowledge:read'),
    ('agent.governance:read'),('conversation:read'),('memory:read'),('analytics:read'),
    ('skill.catalog:read'),('org:read'),
    ('agent:write'),('agent.channel:write'),('agent.skill:write'),('agent.tool:write'),
    ('agent.prompt:write'),('agent.room:write'),('agent.task:write'),('agent.knowledge:write'),
    ('agent.export:read'),('memory:write')
  ) AS p(permission)
  WHERE r.is_system = true AND r.key = 'member'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission")
  SELECT r.id, p.permission FROM "roles" r
  CROSS JOIN (VALUES
    ('agent:read'),('agent.channel:read'),('agent.skill:read'),('agent.tool:read'),
    ('agent.prompt:read'),('agent.room:read'),('agent.task:read'),('agent.knowledge:read'),
    ('agent.governance:read'),('conversation:read'),('memory:read'),('analytics:read'),
    ('skill.catalog:read'),('org:read'),
    ('agent:write'),('agent.channel:write'),('agent.skill:write'),('agent.tool:write'),
    ('agent.prompt:write'),('agent.room:write'),('agent.task:write'),('agent.knowledge:write'),
    ('agent.export:read'),('memory:write'),
    ('agent:delete'),('agent.secret:read'),('agent.secret:write'),('agent.governance:write'),
    ('conversation:delete'),('skill.catalog:write'),('org.member:manage'),('audit_log:read')
  ) AS p(permission)
  WHERE r.is_system = true AND r.key = 'admin'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission")
  SELECT r.id, p.permission FROM "roles" r
  CROSS JOIN (VALUES
    ('agent:read'),('agent.channel:read'),('agent.skill:read'),('agent.tool:read'),
    ('agent.prompt:read'),('agent.room:read'),('agent.task:read'),('agent.knowledge:read'),
    ('agent.governance:read'),('conversation:read'),('memory:read'),('analytics:read'),
    ('skill.catalog:read'),('org:read'),
    ('agent:write'),('agent.channel:write'),('agent.skill:write'),('agent.tool:write'),
    ('agent.prompt:write'),('agent.room:write'),('agent.task:write'),('agent.knowledge:write'),
    ('agent.export:read'),('memory:write'),
    ('agent:delete'),('agent.secret:read'),('agent.secret:write'),('agent.governance:write'),
    ('conversation:delete'),('skill.catalog:write'),('org.member:manage'),('audit_log:read'),
    ('org:write')
  ) AS p(permission)
  WHERE r.is_system = true AND r.key = 'owner'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- instances.workspace_id column, backfilled to the default workspace, then
-- locked NOT NULL. ON DELETE RESTRICT so a workspace can't be deleted while it
-- still owns agents. (The instances -> agents table rename is a later stream.)
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
--> statement-breakpoint
UPDATE "instances"
  SET "workspace_id" = (SELECT id FROM "workspaces" WHERE is_default = true)
  WHERE "workspace_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "instances" ALTER COLUMN "workspace_id" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "instances" ADD CONSTRAINT "instances_workspace_id_workspaces_id_fk"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_instances_workspace" ON "instances" ("workspace_id");
--> statement-breakpoint
-- Backfill: every pre-existing user gets exactly one default-org membership.
INSERT INTO "organization_memberships" ("organization_id", "user_id")
  SELECT (SELECT id FROM "organizations" WHERE is_default = true), u.id
  FROM "users" u
ON CONFLICT ("organization_id","user_id") DO NOTHING;
--> statement-breakpoint
-- Backfill: every pre-existing user gets exactly one Owner org-scope binding.
-- Guarded by NOT EXISTS so re-running adds nothing (no unique constraint on the
-- binding tuple — the guard is the idempotency mechanism).
INSERT INTO "role_bindings" ("user_id", "role_id", "scope_type", "scope_id", "organization_id")
  SELECT
    u.id,
    (SELECT id FROM "roles" WHERE key = 'owner' AND is_system = true),
    'organization',
    (SELECT id FROM "organizations" WHERE is_default = true),
    (SELECT id FROM "organizations" WHERE is_default = true)
  FROM "users" u
  WHERE NOT EXISTS (
    SELECT 1 FROM "role_bindings" rb
    WHERE rb.user_id = u.id
      AND rb.scope_type = 'organization'
      AND rb.organization_id = (SELECT id FROM "organizations" WHERE is_default = true)
      AND rb.role_id = (SELECT id FROM "roles" WHERE key = 'owner' AND is_system = true)
  );
--> statement-breakpoint
-- Promote existing superadmins to Platform Superadmin.
UPDATE "users" SET "is_platform_admin" = true WHERE "role" = 'superadmin';
