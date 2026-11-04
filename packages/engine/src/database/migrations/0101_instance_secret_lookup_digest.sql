-- A keyed digest of the agent API key, so authenticating a request finds the
-- agent with one indexed lookup instead of decrypting every agent's key. The
-- engine computes it (it needs the encryption key), so existing rows start NULL
-- and are filled the first time a lookup reads them.
ALTER TABLE "instance_secrets" ADD COLUMN IF NOT EXISTS "lookup_digest" varchar(64);
CREATE INDEX IF NOT EXISTS "idx_instance_secrets_lookup_digest"
  ON "instance_secrets" ("key", "lookup_digest");
