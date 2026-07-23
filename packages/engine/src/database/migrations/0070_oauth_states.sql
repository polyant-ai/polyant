-- Short-lived OAuth authorization state. `state` is an unguessable nonce (not
-- the conversationId) mapped to the conversation + provider + PKCE verifier.
-- Single-use (deleted on consume) + time-boxed (expires_at) → CSRF + PKCE.
CREATE TABLE IF NOT EXISTS "oauth_states" (
  "state" text PRIMARY KEY NOT NULL,
  "conversation_id" text NOT NULL,
  "instance_id" text NOT NULL,
  "provider" text NOT NULL,
  "code_verifier" text,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_oauth_states_expires" ON "oauth_states" ("expires_at");
