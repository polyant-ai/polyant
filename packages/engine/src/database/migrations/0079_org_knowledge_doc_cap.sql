-- Per-organization cap on the knowledge documents ONE agent may hold.
--
-- The cap itself is not new: `KNOWLEDGE_MAX_DOCS_PER_INSTANCE` has always
-- enforced it. What was wrong is the tier — a per-agent limit configured
-- per-DEPLOYMENT, so two organizations sharing one installation could not be
-- told apart, and raising it for one customer meant a redeploy for all of them.
--
-- NULL means "this organization has none of its own" and falls back to the env
-- var, which stays as the deployment default. Deliberately a DEFAULT and not a
-- ceiling: an entitlement that could only ever be lowered from a value baked
-- into the environment would still need a redeploy to sell.
ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "knowledge_max_docs_per_agent" integer;

-- Refuse a value that cannot mean anything: 0 would forbid the first document
-- while reading as "unset" to anyone skimming, and a negative cap has no reading
-- at all. Absent is spelled NULL, and only NULL.
ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_knowledge_max_docs_per_agent_positive"
  CHECK ("knowledge_max_docs_per_agent" IS NULL OR "knowledge_max_docs_per_agent" > 0);
