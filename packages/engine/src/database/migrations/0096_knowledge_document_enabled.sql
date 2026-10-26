-- A knowledge document can be switched off: it stays stored and listed, but
-- retrieval (vector and full-text) skips it and its chunks until it is switched on.
ALTER TABLE "knowledge_documents" ADD COLUMN IF NOT EXISTS "enabled" boolean DEFAULT true NOT NULL;
