-- Conversation state store: a per-conversation shared key/value blob that every
-- tool can read/write (via ctx.state), plus a server-seeded `_channel` key
-- holding the trusted channel identity. Writes are deterministic (tool code
-- only) and committed on pipeline success (see conversations/state.buffer.ts).
--
-- `scope`/`scope_key` are an abstraction: today only scope = 'conversation'
-- (scope_key = conversationId). `instance_id` is the denormalized slug, kept for
-- the instance-delete cascade (operational/PII tier — slug-text, no UUID FK).

CREATE TABLE IF NOT EXISTS "conversation_state" (
	"scope" text DEFAULT 'conversation' NOT NULL,
	"scope_key" text NOT NULL,
	"instance_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_state_scope_scope_key_pk" PRIMARY KEY("scope","scope_key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_conversation_state_scope_key" ON "conversation_state" USING btree ("scope_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_conversation_state_instance" ON "conversation_state" USING btree ("instance_id");
--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "state_in_prompt_enabled" boolean DEFAULT false NOT NULL;
