// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, asc, desc, eq, sql, inArray } from "drizzle-orm";
import { db } from "../database/client.js";
import { DEFAULT_EMBEDDING_DIM, embeddingProviderFor } from "../embeddings-gateway/config.js";
import type { EmbeddingProvider } from "../embeddings-gateway/types.js";
import { agents } from "./schema.js";
import { conversations, conversationMessages, conversationState } from "../conversations/schema.js";
import { principalSecrets } from "../conversations/principal-secrets.schema.js";
import { memories } from "../memory/schema.js";
import { knowledgeDocuments } from "../knowledge/schema.js";
import { scheduledTasks } from "../scheduled-tasks/schema.js";
import { organizations, workspaces } from "../organizations/organization.schema.js";
import { findDefaultWorkspaceId } from "../organizations/organizations.store.js";
import { buildOrgScopedAgentFilter } from "../authz/scope-filter.js";
import { asAgentSlug, asAgentUuid, type AgentSlug, type AgentUuid } from "./identifiers.js";

// Every agent belongs to exactly one workspace, and a workspace to exactly one
// organization. Which workspace a NEW agent lands in is decided by the caller's
// organization (`resolveWorkspaceIdForPrincipal`), never by the deployment-wide
// default workspace — that single `is_default` row belongs to the organization
// seeded by migration 0051, so using it for an org-B caller is a cross-tenant
// write. Only system paths with no principal (boot seeding) may use it.

/** Anything that can run a `select` — the shared `db` or a transaction handle. */
type Executor = Pick<typeof db, "select">;

/**
 * The organization a caller acts within: its own `orgId` claim, or — when the
 * principal carries none (legacy JWT minted before the claim existed,
 * gateway-forwarded identity) — the deployment's only organization, where the
 * answer is unambiguous.
 *
 * Returns null when it cannot be decided (no claim AND several organizations);
 * callers MUST fail closed on null instead of picking the seed organization.
 */
export async function resolvePrincipalOrgId(
  orgId: string | undefined,
  executor: Executor = db,
): Promise<string | null> {
  if (orgId) return orgId;
  // limit(2) — we only need to know whether the deployment is single-org.
  const rows = await executor.select({ id: organizations.id }).from(organizations).limit(2);
  return rows.length === 1 ? rows[0].id : null;
}

/**
 * The workspace an agent created by this caller must land in: the caller
 * organization's default workspace, else its oldest one.
 *
 * Throws when the organization (or a workspace inside it) cannot be resolved —
 * a create/import must fail rather than silently file the agent under another
 * tenant.
 */
export async function resolveWorkspaceIdForPrincipal(
  orgId: string | undefined,
  executor: Executor = db,
  workspaceSlug?: string,
): Promise<string> {
  const organizationId = await resolvePrincipalOrgId(orgId, executor);
  if (!organizationId) {
    throw new Error(
      "Cannot resolve the caller's organization — refusing to create the agent in another tenant's workspace.",
    );
  }

  // An addressed workspace wins, but ONLY inside the caller's own organization —
  // the slug arrives from the URL the browser is on, so it is caller-controlled
  // input and a match on slug alone would let one tenant file an agent under
  // another's workspace. Unknown-or-foreign is a hard failure rather than a
  // silent fall back to the default, because filing the agent somewhere other
  // than the address bar says is the bug this exists to fix.
  if (workspaceSlug) {
    const [addressed] = await executor
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(eq(workspaces.organizationId, organizationId), eq(workspaces.slug, workspaceSlug)),
      )
      .limit(1);
    if (!addressed) {
      throw new Error(
        `Workspace "${workspaceSlug}" does not belong to the caller's organization.`,
      );
    }
    return addressed.id;
  }

  const [row] = await executor
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.organizationId, organizationId))
    .orderBy(desc(workspaces.isDefault), asc(workspaces.createdAt))
    .limit(1);
  if (!row) {
    throw new Error(`Organization "${organizationId}" owns no workspace to create the agent in.`);
  }
  return row.id;
}

export interface Instance {
  id: AgentUuid;
  slug: AgentSlug;
  name: string;
  description: string | null;
  status: string;
  provider: string | null;
  model: string | null;
  memoryEnabled: boolean;
  knowledgeEnabled: boolean;
  langsmithEnabled: boolean;
  langsmithProject: string | null;
  authEnabled: boolean;
  /**
   * Persisted user preference: enable extended thinking on the model.
   *
   * The field is stored as-is across model changes; the runtime config-resolver
   * gates it behind `isThinkingCapable(provider, model)` so a stale `true`
   * after switching to a non-capable model has no effect.
   */
  thinkingEnabled: boolean;
  /** Reasoning intensity when thinkingEnabled (low|medium|high). Consumed only by Nebius so far. */
  thinkingLevel: string;
  /** Sampling temperature [0, 2]; null = provider default. Gated at runtime by temperatureSupported. */
  temperature: number | null;
  /** When true, the conversation state store is rendered read-only into the system prompt. */
  stateInPromptEnabled: boolean;
  /** When true, inject the current date/time into every turn (volatile tail). */
  datetimeInjectionEnabled: boolean;
  /** Per-instance prompt-cache switch (off = skip all cache markers, no cache write). */
  cacheEnabled: boolean;
  /** Cross-turn Anthropic cache TTL ("5m" | "1h"). */
  cacheTtl: string;
  /** Gates A2A (Agent2Agent) server exposure for this instance. Default false — opt-in. */
  a2aEnabled: boolean;
  /** When true, prior-turn tool calls + results are reconstructed into the model's cross-turn history. */
  toolResultsInHistoryEnabled: boolean;
  /** When true, the exact LLM request payload (system + messages + tools) is persisted per turn for debug. */
  debugEnabled: boolean;
  /** GDPR opt-out feature toggle. */
  optoutEnabled: boolean;
  optoutStopKeywords: string[];
  optoutResumeKeywords: string[];
  optoutClosingMessage: string | null;
  optoutResumeMessage: string | null;
  optoutInjectPromptHint: boolean;
  icon: string | null;
  sttProvider: string;
  embeddingDim: number;
  /** Embedding provider, independent of the chat `provider`: "openai" | "bedrock". */
  embeddingProvider: EmbeddingProvider;
  /** Owning workspace UUID (RBAC tenancy). Every instance belongs to one. */
  workspaceId: string;
  createdAt: Date | null;
  updatedAt: Date | null;
}

function toInstance(row: typeof agents.$inferSelect): Instance {
  return { ...row, id: asAgentUuid(row.id), slug: asAgentSlug(row.slug) } as Instance;
}

/**
 * Return all active agents. Pass the caller's resolved `orgId` to restrict
 * the list to that organization's agents (reuses the RBAC org-scoping predicate
 * so "which agents belong to org X" stays defined in exactly one place).
 * Omitting it returns every agent — reserved for system paths with no principal.
 */
export async function listActiveInstances(orgId?: string): Promise<Instance[]> {
  return db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.status, "active"),
        orgId ? buildOrgScopedAgentFilter(orgId, "slug") : undefined,
      ),
    )
    .then((rows) => rows.map(toInstance));
}

/** Find an instance by slug. Returns undefined if not found. */
export async function findInstanceBySlug(slug: AgentSlug): Promise<Instance | undefined> {
  const rows = await db.select().from(agents).where(eq(agents.slug, slug)).limit(1);
  return rows[0] ? toInstance(rows[0]) : undefined;
}

/** Find an instance by id (UUID). Returns undefined if not found. */
export async function findInstanceById(id: string): Promise<Instance | undefined> {
  const rows = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
  return rows[0] ? toInstance(rows[0]) : undefined;
}

/** Insert an instance if the slug doesn't already exist. Boot seeding only —
 *  a system path with no principal, hence the deployment default workspace. */
export async function ensureInstance(data: {
  slug: AgentSlug;
  name: string;
  description?: string;
}): Promise<void> {
  await db
    .insert(agents)
    .values({
      slug: data.slug,
      name: data.name,
      description: data.description ?? null,
      embeddingDim: DEFAULT_EMBEDDING_DIM,
      workspaceId: await findDefaultWorkspaceId(),
    })
    .onConflictDoNothing({ target: agents.slug });
}

/** Seed the default agents. Call once at startup. */
export async function seedInstances(): Promise<void> {
  await ensureInstance({
    slug: asAgentSlug("default"),
    name: "Default Assistant",
    description: "Default instance — professional and concise",
  });
  await ensureInstance({
    slug: asAgentSlug("creative"),
    name: "Creative Assistant",
    description: "Example alternative instance — informal and playful",
  });
  console.log("Instances seeded (default, creative)");
}

/**
 * Return all agents (any status), ordered by name (case-insensitive). Pass
 * the caller's resolved `orgId` to restrict the list to that organization's
 * agents; omitting it returns every agent — reserved for system paths with no
 * principal (boot channel startup).
 *
 * `workspaceSlug` narrows further to one workspace of that organization. It only
 * ever narrows: the org filter is ANDed underneath, so a slug belonging to
 * another tenant matches nothing rather than reaching across.
 */
export async function listAllInstances(
  orgId?: string,
  workspaceSlug?: string,
): Promise<Instance[]> {
  const orgFilter = orgId ? buildOrgScopedAgentFilter(orgId, "slug") : undefined;
  const workspaceFilter = workspaceSlug
    ? sql`${agents.workspaceId} in (
        select w.id from workspaces w where w.slug = ${workspaceSlug}
      )`
    : undefined;
  return db
    .select()
    .from(agents)
    // Explicit rather than leaning on `and(undefined, undefined)` collapsing to
    // `undefined`: an unconstrained listing is the system-caller path, and it
    // should not depend on a library edge case to stay unconstrained.
    .where(orgFilter || workspaceFilter ? and(orgFilter, workspaceFilter) : undefined)
    .orderBy(sql`LOWER(${agents.name})`)
    .then((rows) => rows.map(toInstance));
}

/** Create a new instance and return it. */
export async function createInstance(data: {
  slug: AgentSlug;
  name: string;
  description?: string;
  provider?: string;
  model?: string;
  /** Caller's organization — decides the owning workspace. Never client-supplied. */
  orgId?: string;
  /**
   * The workspace the caller is addressing, from the URL they are on. Validated
   * against `orgId` before use, so a foreign slug fails rather than filing the
   * agent under another tenant. Omitted → the organization's default workspace.
   */
  workspaceSlug?: string;
}): Promise<Instance> {
  const rows = await db
    .insert(agents)
    .values({
      slug: data.slug,
      name: data.name,
      description: data.description ?? null,
      provider: data.provider ?? null,
      model: data.model ?? null,
      // New agents default to 1024d; the DB default (1536) stays for legacy rows.
      embeddingDim: DEFAULT_EMBEDDING_DIM,
      // Default the embedder to match the chat provider (bedrock chat → bedrock
      // embeddings, else openai). It is independently changeable afterwards.
      embeddingProvider: embeddingProviderFor(data.provider),
      workspaceId: await resolveWorkspaceIdForPrincipal(data.orgId, db, data.workspaceSlug),
    })
    .returning();
  return toInstance(rows[0]);
}

/** Fields a caller is allowed to PATCH. `embeddingDim` is deliberately excluded:
 * it is owned by the embedding-reset pipeline (set on a provider switch) and must
 * never be set directly, or it desyncs from the actual populated vector column. */
type UpdatableInstanceFields = {
  name?: string;
  description?: string | null;
  status?: string;
  provider?: string | null;
  model?: string | null;
  memoryEnabled?: boolean;
  knowledgeEnabled?: boolean;
  langsmithEnabled?: boolean;
  langsmithProject?: string | null;
  authEnabled?: boolean;
  thinkingEnabled?: boolean;
  thinkingLevel?: string;
  temperature?: number | null;
  stateInPromptEnabled?: boolean;
  datetimeInjectionEnabled?: boolean;
  cacheEnabled?: boolean;
  cacheTtl?: string;
  a2aEnabled?: boolean;
  toolResultsInHistoryEnabled?: boolean;
  debugEnabled?: boolean;
  icon?: string | null;
  sttProvider?: string;
  /** Embedder choice (openai|bedrock). Changing it triggers a destructive wipe in the controller. */
  embeddingProvider?: EmbeddingProvider;
  optoutEnabled?: boolean;
  optoutStopKeywords?: string[];
  optoutResumeKeywords?: string[];
  optoutClosingMessage?: string | null;
  optoutResumeMessage?: string | null;
  optoutInjectPromptHint?: boolean;
};

const UPDATABLE_INSTANCE_KEYS: readonly (keyof UpdatableInstanceFields)[] = [
  "name",
  "description",
  "status",
  "provider",
  "model",
  "memoryEnabled",
  "knowledgeEnabled",
  "langsmithEnabled",
  "langsmithProject",
  "authEnabled",
  "thinkingEnabled",
  "thinkingLevel",
  "temperature",
  "stateInPromptEnabled",
  "datetimeInjectionEnabled",
  "cacheEnabled",
  "cacheTtl",
  "a2aEnabled",
  "toolResultsInHistoryEnabled",
  "debugEnabled",
  "icon",
  "sttProvider",
  "embeddingProvider",
  "optoutEnabled",
  "optoutStopKeywords",
  "optoutResumeKeywords",
  "optoutClosingMessage",
  "optoutResumeMessage",
  "optoutInjectPromptHint",
];

/** Update an instance by slug. Touches updatedAt. Returns the updated instance or undefined if not found. */
export async function updateInstance(
  slug: AgentSlug,
  data: UpdatableInstanceFields,
): Promise<Instance | undefined> {
  // Runtime whitelist: TS types do not protect against extra keys arriving via
  // a JSON body (NestJS does not strip them), so only known columns are written.
  const patch: Partial<UpdatableInstanceFields> = {};
  for (const key of UPDATABLE_INSTANCE_KEYS) {
    if (data[key] !== undefined) {
      (patch as Record<string, unknown>)[key] = data[key];
    }
  }
  const rows = await db
    .update(agents)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(agents.slug, slug))
    .returning();
  return rows[0] ? toInstance(rows[0]) : undefined;
}

/**
 * Delete an instance by slug. Returns true if a row was deleted.
 *
 * Runs in a transaction. Operational/PII data is keyed by the instance SLUG in
 * `text` columns with no FK to `agents`, so the DB cascade never reaches it —
 * it must be deleted explicitly here. Config/lifecycle tables (secrets, channels,
 * prompts, tools, skills, room, webhooks) use a `uuid` FK with ON DELETE CASCADE
 * and are cleaned up automatically by the final `DELETE FROM agents`.
 *
 * Audit/telemetry (`tool_audit_logs`, `pipeline_traces`, `ai_logs`) is
 * INTENTIONALLY PRESERVED as a historical record and is left untouched.
 */
export async function deleteInstance(slug: AgentSlug): Promise<boolean> {
  return db.transaction(async (tx) => {
    // conversation_messages has no agent_id — delete via the instance's conversations.
    const convRows = await tx
      .select({ conversationId: conversations.conversationId })
      .from(conversations)
      .where(eq(conversations.instanceId, slug));
    const convIds = convRows.map((r) => r.conversationId);
    if (convIds.length > 0) {
      await tx
        .delete(conversationMessages)
        .where(inArray(conversationMessages.conversationId, convIds));
    }
    await tx.delete(conversations).where(eq(conversations.instanceId, slug));
    await tx.delete(memories).where(eq(memories.instanceId, slug));
    // knowledge_chunks cascade via their document_id FK.
    await tx.delete(knowledgeDocuments).where(eq(knowledgeDocuments.instanceId, slug));
    // scheduled_task_runs cascade via their task_id FK.
    await tx.delete(scheduledTasks).where(eq(scheduledTasks.instanceId, slug));
    // conversation_state is slug-keyed operational/PII data — drop it too.
    await tx.delete(conversationState).where(eq(conversationState.instanceId, slug));
    // principal_secrets (encrypted OAuth tokens) are slug-keyed too.
    await tx.delete(principalSecrets).where(eq(principalSecrets.instanceId, slug));

    const result = await tx.delete(agents).where(eq(agents.slug, slug)).returning();
    return result.length > 0;
  });
}
