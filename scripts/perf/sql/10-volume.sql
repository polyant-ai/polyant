-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Synthetic high-volume dataset for performance baselines.
-- Shape: one large organization (the "dashboard customer") holding about half
-- the traffic, plus many small organizations, plus one long-lived channel
-- conversation. All rows are tagged with the `perf-` prefix.
--
-- psql -v orgs=200 -v big_convs=100000 -v small_convs=500 -v msgs_per_conv=10 -f seed.sql
\set ON_ERROR_STOP on
SET synchronous_commit = off;

\if :{?orgs} \else \set orgs 200 \endif
\if :{?big_convs} \else \set big_convs 100000 \endif
\if :{?small_convs} \else \set small_convs 500 \endif
\if :{?msgs_per_conv} \else \set msgs_per_conv 10 \endif
\if :{?long_conv_msgs} \else \set long_conv_msgs 20000 \endif
\if :{?days} \else \set days 180 \endif

BEGIN;

INSERT INTO organizations (slug, name)
SELECT 'perf-org-' || o, 'Perf Org ' || o FROM generate_series(1, :orgs) o;

INSERT INTO workspaces (organization_id, slug, name)
SELECT org.id, 'perf-ws-' || w, 'Perf WS ' || w
FROM organizations org, generate_series(1, 3) w
WHERE org.slug LIKE 'perf-org-%';

-- 10 agents per workspace in the big org, 3 elsewhere.
INSERT INTO instances (slug, name, workspace_id)
SELECT 'perf-' || o.slug || '-' || ws.slug || '-a' || a, 'Perf agent ' || a, ws.id
FROM workspaces ws
JOIN organizations o ON o.id = ws.organization_id
CROSS JOIN LATERAL generate_series(1, CASE WHEN o.slug = 'perf-org-1' THEN 10 ELSE 3 END) a
WHERE o.slug LIKE 'perf-org-%';

CREATE TEMP TABLE perf_agents AS
SELECT row_number() OVER (ORDER BY i.slug) AS n, i.slug, (o.slug = 'perf-org-1') AS big
FROM instances i JOIN workspaces w ON w.id = i.workspace_id JOIN organizations o ON o.id = w.organization_id
WHERE o.slug LIKE 'perf-org-%';
CREATE INDEX ON perf_agents (big, n);

-- Conversations: big org conversations spread over its 30 agents, small orgs
-- get :small_convs per organization spread over their 9 agents.
CREATE TEMP TABLE perf_convs AS
WITH big AS (SELECT array_agg(slug ORDER BY n) s FROM perf_agents WHERE big),
     small AS (SELECT array_agg(slug ORDER BY n) s FROM perf_agents WHERE NOT big)
SELECT 'perf-c-b' || g AS conversation_id, big.s[1 + (g % array_length(big.s, 1))] AS instance_id,
       now() - random() * :days * interval '1 day' AS created_at
FROM big, generate_series(1, :big_convs) g
UNION ALL
SELECT 'perf-c-s' || g, small.s[1 + (g % array_length(small.s, 1))],
       now() - random() * :days * interval '1 day'
FROM small, generate_series(1, (:orgs - 1) * :small_convs) g;

INSERT INTO conversations (conversation_id, instance_id, created_at, updated_at, title, channel, user_identifier, source)
SELECT conversation_id, instance_id, created_at, created_at + interval '20 minutes',
       'Conversazione ' || conversation_id,
       (ARRAY['web','whatsapp','http','telegram'])[1 + floor(random() * 4)::int],
       'user-' || floor(random() * 50000)::int, 'perf'
FROM perf_convs;

-- Messages: alternating user/assistant, one minute apart; 30% of assistant
-- messages carry a tool call in steps.
INSERT INTO conversation_messages (conversation_id, role, content, steps, created_at)
SELECT c.conversation_id,
       CASE WHEN m % 2 = 1 THEN 'user' ELSE 'assistant' END,
       (ARRAY['Vorrei prenotare un appuntamento per la prossima settimana',
              'Certo, ecco le disponibilità che ho trovato per lei',
              'Qual è il costo della pulizia dei denti?',
              'La fattura del mese scorso non mi torna, potete verificare?',
              'Ho bisogno di parlare con un operatore',
              'Grazie, a presto',
              'Can you send me the contract details again?',
              'The order shipped yesterday and should arrive on Friday'])[1 + floor(random() * 8)::int]
         || ' #' || m,
       CASE WHEN m % 2 = 0 AND random() < 0.3
            THEN jsonb_build_array(jsonb_build_object('finishReason', 'stop',
                   'toolCalls', jsonb_build_array(jsonb_build_object(
                     'toolName', (ARRAY['lookupContact','searchKnowledge','bookAppointment','sendEmail'])[1 + floor(random() * 4)::int],
                     'args', '{}'::jsonb))))
            END,
       c.created_at + (m || ' minutes')::interval
FROM perf_convs c, generate_series(1, :msgs_per_conv) m;

-- One long-lived channel conversation (one contact, one conversation forever).
INSERT INTO conversations (conversation_id, instance_id, created_at, updated_at, title, channel, user_identifier, source)
SELECT 'perf-c-long', slug, now() - interval '365 days', now(), 'Contatto storico', 'whatsapp', 'user-long', 'perf'
FROM perf_agents WHERE big ORDER BY n LIMIT 1;
INSERT INTO conversation_messages (conversation_id, role, content, created_at)
SELECT 'perf-c-long', CASE WHEN m % 2 = 1 THEN 'user' ELSE 'assistant' END,
       'Messaggio storico numero ' || m, now() - interval '365 days' + (m || ' minutes')::interval
FROM generate_series(1, :long_conv_msgs) m;

-- ai_logs and pipeline_traces: one per assistant message.
INSERT INTO ai_logs (provider, model, tier, prompt_tokens, completion_tokens, total_tokens,
                     estimated_cost_usd, duration_ms, conversation_id, instance_id, created_at, outcome)
SELECT 'openai', 'gpt-perf', 'standard', 1200 + (random() * 800)::int, 150 + (random() * 300)::int, 0,
       random() * 0.01, 400 + (random() * 3000)::int, cm.conversation_id, c.instance_id, cm.created_at,
       CASE WHEN random() < 0.02 THEN 'error' ELSE 'ok' END
FROM conversation_messages cm JOIN conversations c ON c.conversation_id = cm.conversation_id
WHERE cm.role = 'assistant' AND c.source = 'perf';
UPDATE ai_logs SET total_tokens = prompt_tokens + completion_tokens WHERE model = 'gpt-perf';

INSERT INTO pipeline_traces (conversation_id, message_id, instance_id, channel, context_prep_ms, llm_call_ms,
                             total_ms, ttfb_ms, prompt_tokens, completion_tokens, tool_calls, created_at, model, provider)
SELECT cm.conversation_id, cm.id, c.instance_id, c.channel, 20 + (random() * 80)::int, 400 + (random() * 3000)::int,
       500 + (random() * 3500)::int, 300 + (random() * 900)::int, 1500, 300,
       CASE WHEN cm.steps IS NOT NULL THEN jsonb_build_array(jsonb_build_object(
         'name', cm.steps->0->'toolCalls'->0->>'toolName', 'duration_ms', (50 + random() * 900)::int, 'success', random() > 0.05)) END,
       cm.created_at, 'gpt-perf', 'openai'
FROM conversation_messages cm JOIN conversations c ON c.conversation_id = cm.conversation_id
WHERE cm.role = 'assistant' AND c.source = 'perf';

INSERT INTO tool_audit_logs (instance_id, tool_name, action, conversation_id, details, success, created_at)
SELECT pt.instance_id, tc->>'name', 'execute', pt.conversation_id, jsonb_build_object('note', 'perf'),
       (tc->>'success')::boolean, pt.created_at
FROM pipeline_traces pt CROSS JOIN LATERAL jsonb_array_elements(pt.tool_calls) tc
WHERE pt.model = 'gpt-perf' AND pt.tool_calls IS NOT NULL;

COMMIT;
ANALYZE;
