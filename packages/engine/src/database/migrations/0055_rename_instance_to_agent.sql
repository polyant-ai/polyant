-- 0055_rename_instance_to_agent.sql
-- Renames the core domain entity instance -> agent at the DB-name layer.
--
-- Two groups:
--   1. instance_* tables (UUID-FK children) -> agent_* + instance_id -> agent_id
--   2. Tables that KEEP their name but rename instance_id -> agent_id
--      (slug-text or FK columns; slug VALUES are unchanged).
--
-- TS symbols (the Drizzle `instances` export, instanceId, resolveInstanceId)
-- are deliberately NOT touched here -- they are renamed in the follow-up engine
-- PR. The /v1 slug contract is unchanged (slug values are untouched).
--
-- Named indexes/constraints keep their legacy instance_* names: Postgres does
-- not auto-rename them, and renaming is cosmetic only (not referenced by any
-- query). DB and Drizzle schema stay mutually consistent on those legacy names.
--
-- Single transaction: any failure rolls the whole rename back.

BEGIN;

-- Main table
ALTER TABLE instances RENAME TO agents;

-- Child tables with UUID FK (rename table + column)
ALTER TABLE instance_prompts   RENAME TO agent_prompts;
ALTER TABLE agent_prompts      RENAME COLUMN instance_id TO agent_id;
ALTER TABLE instance_skills    RENAME TO agent_skills;
ALTER TABLE agent_skills       RENAME COLUMN instance_id TO agent_id;
ALTER TABLE instance_tools     RENAME TO agent_tools;
ALTER TABLE agent_tools        RENAME COLUMN instance_id TO agent_id;
ALTER TABLE instance_secrets   RENAME TO agent_secrets;
ALTER TABLE agent_secrets      RENAME COLUMN instance_id TO agent_id;
ALTER TABLE instance_channels  RENAME TO agent_channels;
ALTER TABLE agent_channels     RENAME COLUMN instance_id TO agent_id;
ALTER TABLE instance_skill_env RENAME TO agent_skill_env;
ALTER TABLE agent_skill_env    RENAME COLUMN instance_id TO agent_id;
ALTER TABLE instance_room      RENAME TO agent_room;
ALTER TABLE agent_room         RENAME COLUMN instance_id TO agent_id;
ALTER TABLE instance_hooks     RENAME TO agent_hooks;
ALTER TABLE agent_hooks        RENAME COLUMN instance_id TO agent_id;

-- Tables keeping their name, column rename only (slug values unchanged)
ALTER TABLE conversations       RENAME COLUMN instance_id TO agent_id;
ALTER TABLE conversation_state  RENAME COLUMN instance_id TO agent_id;
ALTER TABLE memories            RENAME COLUMN instance_id TO agent_id;
ALTER TABLE pipeline_traces     RENAME COLUMN instance_id TO agent_id;
ALTER TABLE tool_audit_logs     RENAME COLUMN instance_id TO agent_id;
ALTER TABLE ai_logs             RENAME COLUMN instance_id TO agent_id;
ALTER TABLE knowledge_documents RENAME COLUMN instance_id TO agent_id;
ALTER TABLE knowledge_chunks    RENAME COLUMN instance_id TO agent_id;
ALTER TABLE scheduled_tasks     RENAME COLUMN instance_id TO agent_id;
ALTER TABLE scheduled_task_runs RENAME COLUMN instance_id TO agent_id;
ALTER TABLE event_sources       RENAME COLUMN instance_id TO agent_id;
ALTER TABLE event_backlog       RENAME COLUMN instance_id TO agent_id;
ALTER TABLE room_activity_log   RENAME COLUMN instance_id TO agent_id;
ALTER TABLE contact_optouts     RENAME COLUMN instance_id TO agent_id;
ALTER TABLE hook_executions     RENAME COLUMN instance_id TO agent_id;

COMMIT;
