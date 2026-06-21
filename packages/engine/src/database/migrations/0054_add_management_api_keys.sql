-- RBAC Stream 5 — Management API keys (machine principals).
--
-- Creates `management_api_keys`: org-scoped, bcrypt-hashed credentials that let
-- non-human callers (CI, cron, SaaS connectors) reach `/api/*` via the
-- `X-Polyant-Key` header instead of an OAuth session. Each key carries an
-- explicit permission set (jsonb) so a leaked key never grants more than it was
-- issued, an optional hard `expires_at`, and a best-effort `last_used_at`.
--
-- The presented token is `pk_<id>_<secret>`: `id` selects the row, `secret` is
-- verified against `key_hash` with bcrypt; only the hash is ever stored.
--
-- Idempotent (IF NOT EXISTS) so re-running is a no-op. CASCADE on the org so a
-- deleted organization takes its keys with it.

CREATE TABLE IF NOT EXISTS "management_api_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "name" varchar(255) NOT NULL,
  "key_hash" text NOT NULL,
  "permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "expires_at" timestamp with time zone,
  "last_used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "management_api_keys"
    ADD CONSTRAINT "management_api_keys_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_management_api_keys_org" ON "management_api_keys" ("organization_id");
