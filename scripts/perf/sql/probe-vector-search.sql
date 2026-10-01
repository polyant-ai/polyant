-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Same shape as knowledge/store.ts searchByVector (fetchLimit 20), per agent size.
\set ON_ERROR_STOP on
CREATE TEMP TABLE q AS SELECT (SELECT array_agg(random() - 0.5) FROM generate_series(1, 1024))::vector(1024) v,
                              (SELECT array_agg(random() - 0.5) FROM generate_series(1, 1536))::vector(1536) w;
\echo == small agent (500 chunks)
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON) SELECT kc.id, kd.filename, kc.embedding_1024 <=> q.v AS d FROM knowledge_chunks kc JOIN knowledge_documents kd ON kd.id = kc.document_id, q
 WHERE kc.instance_id = 'perf-perf-org-5-perf-ws-1-a1' AND kc.embedding_1024 IS NOT NULL ORDER BY kc.embedding_1024 <=> q.v LIMIT 20;
\echo == medium agent (5k chunks)
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON) SELECT kc.id, kd.filename, kc.embedding_1024 <=> q.v AS d FROM knowledge_chunks kc JOIN knowledge_documents kd ON kd.id = kc.document_id, q
 WHERE kc.instance_id = 'perf-perf-org-1-perf-ws-1-a2' AND kc.embedding_1024 IS NOT NULL ORDER BY kc.embedding_1024 <=> q.v LIMIT 20;
\echo == big agent (50k chunks)
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON) SELECT kc.id, kd.filename, kc.embedding_1024 <=> q.v AS d FROM knowledge_chunks kc JOIN knowledge_documents kd ON kd.id = kc.document_id, q
 WHERE kc.instance_id = 'perf-perf-org-1-perf-ws-1-a1' AND kc.embedding_1024 IS NOT NULL ORDER BY kc.embedding_1024 <=> q.v LIMIT 20;
\echo == 1536-dim agent (20k chunks, no ANN index)
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON) SELECT kc.id, kd.filename, kc.embedding <=> q.w AS d FROM knowledge_chunks kc JOIN knowledge_documents kd ON kd.id = kc.document_id, q
 WHERE kc.instance_id = 'perf-perf-org-1-perf-ws-1-a9' AND kc.embedding IS NOT NULL ORDER BY kc.embedding <=> q.w LIMIT 20;
