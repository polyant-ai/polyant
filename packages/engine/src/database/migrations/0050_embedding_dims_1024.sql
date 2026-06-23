-- 0050_embedding_dims_1024.sql
-- Add parallel 1024-dim embedding columns to memories and knowledge_chunks,
-- plus a per-instance dim flag. Existing 1536-dim rows are preserved via a
-- nullable XOR relationship with the new column.

BEGIN;

ALTER TABLE "memories" ADD COLUMN "embedding_1024" vector(1024);
ALTER TABLE "memories" ADD COLUMN "embedding_provider" text;
ALTER TABLE "memories" ALTER COLUMN "embedding" DROP NOT NULL;
ALTER TABLE "memories"
  ADD CONSTRAINT "memories_embedding_xor"
  CHECK (("embedding" IS NULL) <> ("embedding_1024" IS NULL));
CREATE INDEX IF NOT EXISTS "idx_memories_embedding_1024_cosine"
  ON "memories" USING hnsw ("embedding_1024" vector_cosine_ops);

ALTER TABLE "knowledge_chunks" ADD COLUMN "embedding_1024" vector(1024);
ALTER TABLE "knowledge_chunks" ADD COLUMN "embedding_provider" text;
ALTER TABLE "knowledge_chunks" ALTER COLUMN "embedding" DROP NOT NULL;
ALTER TABLE "knowledge_chunks"
  ADD CONSTRAINT "knowledge_chunks_embedding_xor"
  CHECK (("embedding" IS NULL) <> ("embedding_1024" IS NULL));
CREATE INDEX IF NOT EXISTS "idx_knowledge_chunks_embedding_1024_cosine"
  ON "knowledge_chunks" USING hnsw ("embedding_1024" vector_cosine_ops);

ALTER TABLE "instances"
  ADD COLUMN "embedding_dim" integer NOT NULL DEFAULT 1536;

COMMIT;
