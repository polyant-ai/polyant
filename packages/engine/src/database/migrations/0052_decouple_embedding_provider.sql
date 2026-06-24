-- 0052_decouple_embedding_provider.sql
-- Decouple the embedding provider from the chat provider. Until now the embedder
-- was derived at runtime from `instances.provider` (bedrock → bedrock, else
-- openai). It becomes an independent, admin-selectable column.
--
-- Backfill mirrors the old derivation so EVERY existing instance keeps its current
-- embedding space: no instance changes embedder and no vectors are wiped.

BEGIN;

ALTER TABLE "instances"
  ADD COLUMN "embedding_provider" varchar(20) NOT NULL DEFAULT 'openai';

UPDATE "instances"
  SET "embedding_provider" = CASE WHEN "provider" = 'bedrock' THEN 'bedrock' ELSE 'openai' END;

COMMIT;
