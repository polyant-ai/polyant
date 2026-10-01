-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Knowledge base volume for vector-search load tests. Random unit-ish vectors:
-- fine for latency and for counting results per tenant, meaningless for recall
-- quality. One document per 100 chunks. kb_div divides every chunk count
-- (prepare-environment.sh passes 100 for SCALE=small).
--   perf-org-1 ws-1 a1         50k chunks, 1024 dims (indexed column)
--   perf-org-1 ws-1 a2..a8      5k chunks each, 1024 dims
--   perf-org-1 ws-1 a9         20k chunks, 1536 dims (no ANN index on that column)
--   perf-org-1 ws-1 a10         5k chunks, 1024 dims
--   20 small agents (org 2..21 ws-1 a1)  500 chunks each, 1024 dims
--   perf-org-1 ws-2/ws-3 a1..a10  3k chunks each, 1024 dims, search NOT enabled
\set ON_ERROR_STOP on
\if :{?kb_div} \else \set kb_div 1 \endif
SET synchronous_commit = off;
SET maintenance_work_mem = '768MB';
-- Parallel builds use shared memory: the container needs --shm-size above 64 MB.
SET max_parallel_maintenance_workers = 2;

CREATE TEMP TABLE kb_plan (slug text, chunks int, dim int, searchable boolean);
INSERT INTO kb_plan
SELECT 'perf-perf-org-1-perf-ws-1-a' || a,
       (CASE WHEN a = 1 THEN 50000 WHEN a = 9 THEN 20000 ELSE 5000 END) / :kb_div,
       CASE WHEN a = 9 THEN 1536 ELSE 1024 END, true
FROM generate_series(1, 10) a
UNION ALL SELECT 'perf-perf-org-' || o || '-perf-ws-1-a1', greatest(100, 500 / :kb_div), 1024, true FROM generate_series(2, 21) o
UNION ALL SELECT 'perf-perf-org-1-perf-ws-' || w || '-a' || a, 3000 / :kb_div, 1024, false FROM generate_series(2, 3) w, generate_series(1, 10) a;

UPDATE instances i SET knowledge_enabled = p.searchable, embedding_dim = p.dim, embedding_provider = 'openai'
FROM kb_plan p WHERE i.slug = p.slug;

INSERT INTO instance_tools (instance_id, tool_id)
SELECT i.id, t.id FROM kb_plan p JOIN instances i ON i.slug = p.slug JOIN tools t ON t.name = 'searchKnowledge'
WHERE p.searchable ON CONFLICT DO NOTHING;

INSERT INTO knowledge_documents (instance_id, filename, mime_type, size_bytes, raw_content, content_hash, status, chunk_count)
SELECT p.slug, 'perf-doc-' || d || '.md', 'text/markdown', 40000, '', md5(p.slug || d), 'ready', 100
FROM kb_plan p, generate_series(1, greatest(1, p.chunks / 100)) d;

DROP INDEX IF EXISTS idx_knowledge_chunks_embedding_1024_cosine;

INSERT INTO knowledge_chunks (document_id, instance_id, content, chunk_index, embedding, embedding_1024, embedding_provider)
SELECT d.id, d.instance_id,
       (ARRAY['Orari di apertura della clinica dal lunedì al venerdì',
              'Il costo della pulizia dei denti dipende dal piano scelto',
              'Procedura di reso: entro trenta giorni dalla consegna',
              'Le fatture sono disponibili nell area riservata',
              'Per parlare con un operatore chiamare il numero verde',
              'Shipping times vary between two and five working days',
              'The warranty covers manufacturing defects for two years',
              'Il contratto si rinnova automaticamente ogni anno'])[1 + (c % 8)] || ' sezione ' || c,
       c,
       CASE WHEN p.dim = 1536 THEN (SELECT array_agg(random() - 0.5) FROM generate_series(1, 1536) WHERE c >= 0)::vector END,
       CASE WHEN p.dim = 1024 THEN (SELECT array_agg(random() - 0.5) FROM generate_series(1, 1024) WHERE c >= 0)::vector END,
       'openai'
FROM knowledge_documents d
JOIN kb_plan p ON p.slug = d.instance_id
CROSS JOIN generate_series(0, 99) c
WHERE d.filename LIKE 'perf-doc-%';

\timing on
CREATE INDEX idx_knowledge_chunks_embedding_1024_cosine ON knowledge_chunks USING hnsw (embedding_1024 vector_cosine_ops);
\timing off
ANALYZE knowledge_chunks;
ANALYZE knowledge_documents;
