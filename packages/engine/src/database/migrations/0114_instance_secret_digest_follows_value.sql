-- The lookup digest of an agent API key describes one value. A writer that
-- replaces the value without knowing the column (a replica of the previous
-- release during a rolling deploy, or after a rollback) would leave the digest
-- of the replaced key: that key would keep authenticating and the new one would
-- be refused. The trigger clears the digest whenever the value changes and the
-- writer did not set a new digest itself, so the engine recomputes it from the
-- stored value on the next lookup.
CREATE OR REPLACE FUNCTION "instance_secrets_clear_stale_digest"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."value" IS DISTINCT FROM OLD."value"
     AND NEW."lookup_digest" IS NOT DISTINCT FROM OLD."lookup_digest" THEN
    NEW."lookup_digest" := NULL;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_instance_secrets_clear_stale_digest" ON "instance_secrets";
--> statement-breakpoint
CREATE TRIGGER "trg_instance_secrets_clear_stale_digest"
  BEFORE UPDATE ON "instance_secrets"
  FOR EACH ROW EXECUTE FUNCTION "instance_secrets_clear_stale_digest"();
