-- Encrypted per-principal secret store (OAuth tokens) — the cifered sibling of
-- conversation_state. Values are AES-256-GCM; never stored/logged in clear.
-- scope/scope_key mirror conversation_state (today scope='conversation',
-- scope_key=conversationId). expires_at drives token refresh (null = never).
CREATE TABLE IF NOT EXISTS "principal_secrets" (
  "scope" text NOT NULL DEFAULT 'conversation',
  "scope_key" text NOT NULL,
  "instance_id" text,
  "key" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "principal_secrets_scope_scope_key_key_pk" PRIMARY KEY("scope","scope_key","key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_principal_secrets_scope_key" ON "principal_secrets" ("scope_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_principal_secrets_instance" ON "principal_secrets" ("instance_id");
