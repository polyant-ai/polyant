-- An agent can ask its provider for fast mode on a model that offers it.
ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "fast_mode" boolean DEFAULT false NOT NULL;
