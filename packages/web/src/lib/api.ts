// SPDX-License-Identifier: AGPL-3.0-or-later

import { workspaceSlugFromPath } from "@/lib/tenant/paths";

// Re-export all types for backward compatibility
export type {
  AdminUser,
  CreateUserResponse,
  ResetPasswordResponse,
  MemberRole,
  OrganizationMember,
  ManagementApiKey,
  CreatedManagementApiKey,
  Instance,
  SecretStatus,
  ChannelConfig,
  RoomConfigResponse,
  ModelInfo,
  ModelsResponse,
  PromptSection,
  ToolState,
  ToolPluginInfo,
  RequiredSecretSpec,
  RequiredEnvEntry,
  SkillState,
  SkillEnvStatus,
  LibrarySkillSummary,
  LibrarySkillDetail,
  SkillUpdateResponse,
  SkillVersion,
  ScheduledTask,
  ScheduledTaskSchedule,
  ScheduledTaskRun,
  ConversationListItem,
  ConversationSearchResult,
  ConversationMessage,
  CostBreakdown,
  MessageLatency,
  MessageDebug,
  TurnModelCall,
  LlmDebugPayload,
  ReasoningDetail,
  StepDetail,
  AttachmentMeta,
  Memory,
  KnowledgeDocument,
  KnowledgeDocumentDetail,
  AnalyticsOverview,
  DailyTrendRow,
  HourlyRow,
  ChannelRow,
  ModelRow,
  TierRow,
  ToolRow,
  InstanceComparisonRow,
  LatencyOverview,
  LatencyDailyRow,
  PhaseBreakdownRow,
  ToolLatencyRow,
  LatencyData,
  AnalyticsResponse,
  ToolInfo,
  MonitorOutcome,
  MonitorItem,
  MonitorSection,
  MonitorDetail,
  MonitorTypeInfo,
  MonitorPage,
  EventSource,
  EventDefinition,
  HookEvent,
  InstanceHook,
  HookFunctionInfo,
  HookExecution,
  BacklogEvent,
  ActivityLogEntry,
  OptoutContact,
  EmbeddingWipeResult,
  McpAuthMode,
  McpOAuthAccount,
  McpServer,
  McpTestResult,
} from "./api-types";

// Re-export value-level constants (the `export type` block above only carries types).
export { MEMBER_ROLES } from "./api-types";

// Internal import — only types used in the api object below (re-exports don't make types locally available)
import type {
  AdminUser,
  CreateUserResponse,
  ResetPasswordResponse,
  Instance,
  SecretStatus,
  ChannelConfig,
  RoomConfigResponse,
  ModelsResponse,
  PromptSection,
  ToolState,
  ToolPluginInfo,
  RequiredSecretSpec,
  SkillState,
  SkillEnvStatus,
  LibrarySkillSummary,
  LibrarySkillDetail,
  SkillUpdateResponse,
  SkillVersion,
  ScheduledTask,
  ScheduledTaskSchedule,
  ScheduledTaskRun,
  ConversationListItem,
  ConversationMessage,
  MessageDebug,
  Memory,
  KnowledgeDocument,
  KnowledgeDocumentDetail,
  AnalyticsResponse,
  ToolInfo,
  MonitorDetail,
  MonitorOutcome,
  MonitorPage,
  EventSource,
  EventDefinition,
  HookEvent,
  InstanceHook,
  HookFunctionInfo,
  HookExecution,
  BacklogEvent,
  ActivityLogEntry,
  OptoutContact,
  EmbeddingWipeResult,
  OrganizationMember,
  ManagementApiKey,
  CreatedManagementApiKey,
  McpAuthMode,
  McpServer,
  McpTestResult,
  TenantContextPayload,
  OnboardingState,
  OnboardingPatch,
} from "./api-types";

// ── HTTP Client ─────────────────────────────────────────────────────

// API calls go through Next.js rewrites (which proxy to engine and forward cookies)
// In client components, relative paths are resolved against the browser origin (the Next.js app)
export const API_BASE = "";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const { headers, signal, ...rest } = options ?? {};
  // The workspace comes from the URL being rendered — the one thing the user can
  // see, share and bookmark. Reading it here rather than from a cookie is what
  // makes the URL segment authoritative: there is no second, invisible notion of
  // "the active workspace" that a link could disagree with. A path outside a
  // workspace (org- or deployment-level) sends no header and is resolved by the
  // caller's stored preference server-side.
  const workspaceSlug =
    typeof window !== "undefined" ? workspaceSlugFromPath(window.location.pathname) : null;
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(workspaceSlug ? { "X-Workspace-Slug": workspaceSlug } : {}),
      ...headers,
    },
    signal: signal ?? AbortSignal.timeout(30_000),
    ...rest,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new ApiError(res.status, body.message ?? res.statusText);
  }

  return res.json();
}

/**
 * Build a request path with every interpolated value percent-encoded, so a slug
 * or id with a `/`, `?` or `#` in it can never change which route is called:
 * ``urlPath`/api/instances/${slug}/skills/${skillSlug}` ``. Literal text is left alone.
 */
function urlPath(strings: TemplateStringsArray, ...values: readonly (string | number)[]): string {
  return strings.reduce((out, text, i) => out + text + (i < values.length ? encodeURIComponent(String(values[i])) : ""), "");
}

/** Append a query string to `base`, leaving out parameters that are `undefined` or an empty string. */
function withQuery(
  base: string,
  params: Record<string, string | number | boolean | undefined | readonly string[]>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    if (typeof value === "object") for (const item of value) query.append(key, item);
    else query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `${base}?${text}` : base;
}

/** The `RequestInit` for a call with a JSON body. */
function json(method: "POST" | "PUT" | "PATCH" | "DELETE", body: unknown): RequestInit {
  return { method, body: JSON.stringify(body) };
}

/**
 * Whether a rejection is the engine refusing on AUTHORIZATION grounds.
 *
 * The panel holds no read-model of the caller's permissions — the session
 * carries the DEPLOYMENT-level `isPlatformAdmin` flag and nothing about their
 * role in the organization, which is where RBAC is decided. So a surface cannot
 * ask "may I?" before rendering; it learns from the refusal. This predicate is
 * that seam, and it exists as one function rather than an inline
 * `status === 403` per call site so the check reads as an authorization
 * concept instead of a magic number.
 *
 * The message is deliberately NOT surfaced to the user with it: `PermissionGuard`
 * throws `Missing permission: audit_log:read`, an internal key that means nothing
 * to a reader and leaks vocabulary. Callers render their own explanation.
 */
export function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403;
}

/**
 * Extract a user-safe error message. Strips server internals (paths, stack traces)
 * and caps length. Falls back to the provided default message.
 */
export function getUserErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const msg = err.message;
    // Only show short, non-technical messages to the user
    if (msg.length < 200 && !/\b(at |Error:|ECONNREFUSED|\/[a-z]+\/)/i.test(msg)) {
      return msg;
    }
    return fallback;
  }
  if (err instanceof Error && err.name === "TimeoutError") {
    return "Request timed out. Please try again.";
  }
  return fallback;
}

// ── API Methods ─────────────────────────────────────────────────────

/**
 * The numeric installation policies. Named as a list so the form, the patch and
 * the effective shape below cannot drift apart — the engine keeps the same list
 * for the same reason.
 */
export const PLATFORM_SETTING_NUMBERS = [
  "analyticsRetentionDays",
  "sseMaxConnections",
  "sseMaxConnectionsPerUser",
  "throttleTtlMs",
  "throttleLimit",
  "agentCallTimeoutMs",
  "mcpConnectTimeoutMs",
  "schedulerOrphanGraceMs",
  "schedulerDefaultMaxRunMs",
] as const;

export type PlatformSettingNumber = (typeof PLATFORM_SETTING_NUMBERS)[number];

export type PlatformSettings = { [K in PlatformSettingNumber]: number | null } & {
  /** The engine's public origin. Null means `BASE_URL`, or localhost, is in force. */
  baseUrl: string | null;
};

/**
 * Both shapes come back from the engine on purpose: `settings` is what is
 * STORED (null = unset) and `effective` is what is in FORCE. The form needs
 * both — an empty field must stay empty, and its placeholder is what that empty
 * field will actually do.
 */
export interface PlatformSettingsResponse {
  settings: PlatformSettings;
  effective: { [K in PlatformSettingNumber]: number } & { baseUrl: string };
}

export const api = {
  platform: {
    settings: () => request<PlatformSettingsResponse>("/api/platform/settings"),
    updateSettings: (body: Partial<PlatformSettings>) =>
      request<PlatformSettingsResponse>("/api/platform/settings", json("PATCH", body)),
  },
  users: {
    /**
     * One page of installation accounts. `total` is what makes the page
     * navigable — the engine bounds the response, so the caller cannot infer the
     * end of the table from a short page.
     */
    list: (params: { limit?: number; offset?: number } = {}) => {
      return request<{ users: AdminUser[]; total: number }>(withQuery("/api/users", params));
    },
    create: (data: { email: string; name?: string; isPlatformAdmin?: boolean; password?: string }) =>
      request<CreateUserResponse>("/api/users", json("POST", data)),
    update: (id: string, data: { name?: string | null; isPlatformAdmin?: boolean }) =>
      request<{ user: AdminUser }>(urlPath`/api/users/${id}`, json("PATCH", data)),
    delete: (id: string) =>
      request<{ deleted: boolean }>(urlPath`/api/users/${id}`, {
        method: "DELETE",
      }),
    resetPassword: (id: string) =>
      request<ResetPasswordResponse>(urlPath`/api/users/${id}/reset-password`, {
        method: "POST",
      }),
  },
  me: {
    // The caller's whole tenancy, whichever page asks: it must NOT carry the
    // workspace of the address being rendered. The engine refuses a request that
    // names a workspace it does not know, so a mistyped one in the URL answered 403
    // here and the panel read it as "you belong to no organization" instead of
    // "this page does not exist". An empty value overrides the header `request`
    // derives from the URL, and the engine reads an empty header as absent.
    get: () =>
      request<TenantContextPayload>("/api/me", {
        headers: { "X-Workspace-Slug": "" },
      }),
    changePassword: (data: { currentPassword?: string; newPassword: string }) =>
      request<{ ok: boolean }>("/api/me/password", json("POST", data)),
    /** Writes the caller's own guidance state; the engine returns the merged record. */
    updateOnboarding: (patch: OnboardingPatch) =>
      request<{ onboarding: OnboardingState }>("/api/me/onboarding", json("PATCH", patch)),
  },
  members: {
    list: (orgSlug: string) =>
      request<{ members: OrganizationMember[] }>(
        urlPath`/api/organizations/${orgSlug}/members`,
      ),
    assign: (userId: string, roleKey: string, orgSlug: string) =>
      request<{ assigned: boolean }>(
        urlPath`/api/organizations/${orgSlug}/members/${userId}`,
        json("PUT", { roleKey }),
      ),
    remove: (userId: string, orgSlug: string) =>
      request<{ removed: boolean }>(
        urlPath`/api/organizations/${orgSlug}/members/${userId}`,
        { method: "DELETE" },
      ),
  },
  apiKeys: {
    list: (orgSlug: string) =>
      request<{ keys: ManagementApiKey[] }>(
        urlPath`/api/organizations/${orgSlug}/api-keys`,
      ),
    create: (orgSlug: string, data: { name: string; expiresAt?: string }) =>
      request<CreatedManagementApiKey>(
        urlPath`/api/organizations/${orgSlug}/api-keys`,
        json("POST", data),
      ),
    remove: (orgSlug: string, keyId: string) =>
      request<{ deleted: boolean }>(
        urlPath`/api/organizations/${orgSlug}/api-keys/${keyId}`,
        { method: "DELETE" },
      ),
  },
  instances: {
    list: () => request<{ instances: Instance[] }>("/api/instances"),
    get: (slug: string) =>
      request<{ instance: Instance }>(urlPath`/api/instances/${slug}`),
    create: (data: { slug: string; name: string; description?: string; provider?: string; model?: string }) =>
      request<{ instance: Instance }>("/api/instances", json("POST", data)),
    update: (
      slug: string,
      data: {
        name?: string;
        description?: string | null;
        status?: string;
        provider?: string | null;
        model?: string | null;
        embeddingProvider?: string;
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
        // Nullable, not merely optional: null CLEARS the override back to the
        // deployment default, while omitting the field leaves it alone.
        datetimeTimezone?: string | null;
        datetimeLocale?: string | null;
        dedupSimilarityThreshold?: number | null;
        messageSoftDebounceMs?: number | null;
        messageTypingDelayMs?: number | null;
        messageMaxRestarts?: number | null;
        cacheEnabled?: boolean;
        cacheTtl?: string;
        a2aEnabled?: boolean;
        toolResultsInHistoryEnabled?: boolean;
        debugEnabled?: boolean;
        attachmentStorageEnabled?: boolean;
        sttProvider?: "openai" | "aws" | "deepgram" | "disabled";
        optoutEnabled?: boolean;
        optoutStopKeywords?: string[];
        optoutResumeKeywords?: string[];
        optoutClosingMessage?: string | null;
        optoutResumeMessage?: string | null;
        optoutInjectPromptHint?: boolean;
        webContextFieldMapping?: Record<string, string>;
        /** One of the embedder's `supportedDims`; changing it wipes like a provider switch. */
        embeddingDim?: number;
        /** Acknowledge the destructive memory/knowledge wipe on an embedding provider or dimension change. */
        confirmWipe?: boolean;
      },
    ) =>
      request<{ instance: Instance; wiped?: EmbeddingWipeResult | null }>(
        urlPath`/api/instances/${slug}`,
        json("PATCH", data),
      ),
    delete: (slug: string) =>
      request<{ deleted: boolean }>(urlPath`/api/instances/${slug}`, {
        method: "DELETE",
      }),
    setIcon: (slug: string, icon: string) =>
      request<{ instance: Instance }>(urlPath`/api/instances/${slug}/icon`, json("PUT", { icon })),
    deleteIcon: (slug: string) =>
      request<{ instance: Instance }>(urlPath`/api/instances/${slug}/icon`, {
        method: "DELETE",
      }),
  },
  prompts: {
    list: (slug: string) =>
      request<{ prompts: PromptSection[] }>(urlPath`/api/instances/${slug}/prompts`),
    update: (slug: string, sections: { key: string; content: string }[]) =>
      request<{ prompts: PromptSection[] }>(urlPath`/api/instances/${slug}/prompts`, json("PATCH", { sections })),
  },
  tools: {
    list: (slug: string) =>
      request<{ tools: ToolState[]; plugins?: ToolPluginInfo[] }>(urlPath`/api/instances/${slug}/tools`),
    update: (slug: string, enabled: string[]) =>
      request<{ tools: ToolState[]; plugins?: ToolPluginInfo[] }>(urlPath`/api/instances/${slug}/tools`, json("PATCH", { enabled })),
    requiredSecrets: (slug: string) =>
      request<{ requiredSecrets: RequiredSecretSpec[] }>(urlPath`/api/instances/${slug}/tools/required-secrets`),
    catalog: () =>
      request<{ tools: ToolInfo[] }>("/api/tools"),
  },
  models: {
    list: () => request<ModelsResponse>("/api/instances/models"),
  },
  skills: {
    list: (slug: string) =>
      request<{ skills: SkillState[] }>(urlPath`/api/instances/${slug}/skills`),
    update: (slug: string, enabled: string[]) =>
      request<SkillUpdateResponse>(urlPath`/api/instances/${slug}/skills`, json("PATCH", { enabled })),
    upgrade: (slug: string, skillSlug: string) =>
      request<{ upgraded: boolean }>(urlPath`/api/instances/${slug}/skills/${skillSlug}/upgrade`, { method: "POST" }),
    rollback: (slug: string, skillSlug: string, versionId: string) =>
      request<{ rolledBack: boolean }>(urlPath`/api/instances/${slug}/skills/${skillSlug}/rollback`, json("POST", { versionId })),
    getEnv: (slug: string, skillSlug: string) =>
      request<{ env: SkillEnvStatus[] }>(
        urlPath`/api/instances/${slug}/skills/${skillSlug}/env`,
      ),
    setEnv: (
      slug: string,
      skillSlug: string,
      env: { key: string; value: string; sensitive: boolean }[],
    ) =>
      request<{ env: SkillEnvStatus[] }>(
        urlPath`/api/instances/${slug}/skills/${skillSlug}/env`,
        json("PUT", { env }),
      ),
    setAutoLoad: (slug: string, skillSlug: string, autoLoad: boolean) =>
      request<{ autoLoad: boolean }>(
        urlPath`/api/instances/${slug}/skills/${skillSlug}/auto-load`,
        json("POST", { autoLoad }),
      ),
  },
  secrets: {
    list: (slug: string) =>
      request<{ secrets: SecretStatus[] }>(urlPath`/api/instances/${slug}/secrets`),
    set: (slug: string, secrets: { key: string; value: string }[]) =>
      request<{ secrets: SecretStatus[] }>(urlPath`/api/instances/${slug}/secrets`, json("PUT", { secrets })),
    delete: (slug: string, key: string) =>
      request<{ deleted: boolean }>(urlPath`/api/instances/${slug}/secrets/${key}`, {
        method: "DELETE",
      }),
  },
  channels: {
    list: (slug: string) =>
      request<{ channels: ChannelConfig[] }>(urlPath`/api/instances/${slug}/channels`),
    slackWebhookUrl: (slug: string) =>
      request<{ webhookUrl: string }>(urlPath`/api/instances/${slug}/channels/slack/webhook-url`),
    /** Where a caller reaches the Web channel; `baseUrlConfigured` false means the localhost fallback. */
    webEndpoint: (slug: string) =>
      request<{ endpointUrl: string; baseUrlConfigured: boolean }>(urlPath`/api/instances/${slug}/channels/web/endpoint`),
    set: (slug: string, channelType: string, config: Record<string, unknown>, enabled: boolean) =>
      // `webhookUrl` is present only when the saved channel ends up in
      // Twilio API Key mode (see the engine's `buildChannelResponse`).
      request<{ channel: ChannelConfig | null; webhookUrl?: string }>(
        urlPath`/api/instances/${slug}/channels/${channelType}`,
        json("PUT", { config, enabled }),
      ),
    delete: (slug: string, channelType: string) =>
      request<{ deleted: boolean }>(
        urlPath`/api/instances/${slug}/channels/${channelType}`,
        { method: "DELETE" },
      ),
    webhookUrl: (slug: string) =>
      request<{ webhookUrl: string }>(
        urlPath`/api/instances/${slug}/channels/whatsapp/webhook-url`,
      ),
    rotateWebhookSecret: (slug: string) =>
      request<{ webhookUrl: string }>(
        urlPath`/api/instances/${slug}/channels/whatsapp/rotate-webhook-secret`,
        { method: "POST" },
      ),
  },
  mcpServers: {
    list: (slug: string) =>
      request<McpServer[]>(urlPath`/api/instances/${slug}/mcp-servers`),
    set: (
      slug: string,
      serverSlug: string,
      body: { name: string; url: string; authMode: McpAuthMode; enabled: boolean; config: Record<string, unknown> },
    ) =>
      request<{ ok: boolean }>(
        urlPath`/api/instances/${slug}/mcp-servers/${serverSlug}`,
        json("PUT", body),
      ),
    delete: (slug: string, serverSlug: string) =>
      request<{ deleted: boolean }>(
        urlPath`/api/instances/${slug}/mcp-servers/${serverSlug}`,
        { method: "DELETE" },
      ),
    test: (
      slug: string,
      body: { slug?: string; name: string; url: string; authMode: McpAuthMode; enabled: boolean; config: Record<string, unknown> },
    ) =>
      request<McpTestResult>(urlPath`/api/instances/${slug}/mcp-servers/test`, json("POST", body)),
    /** Start connecting the agent's shared account; the panel opens the returned URL. */
    connectShared: (slug: string, serverSlug: string) =>
      request<{ authorizeUrl: string }>(
        urlPath`/api/instances/${slug}/mcp-servers/${serverSlug}/shared-account`,
        { method: "POST" },
      ),
    disconnectShared: (slug: string, serverSlug: string) =>
      request<{ disconnected: boolean }>(
        urlPath`/api/instances/${slug}/mcp-servers/${serverSlug}/shared-account`,
        { method: "DELETE" },
      ),
  },
  knowledge: {
    list: (slug: string) =>
      request<{ documents: KnowledgeDocument[] }>(urlPath`/api/instances/${slug}/knowledge`),
    get: (slug: string, docId: string) =>
      request<{ document: KnowledgeDocumentDetail }>(
        urlPath`/api/instances/${slug}/knowledge/${docId}`,
      ),
    upload: (slug: string, data: { filename: string; content: string }) =>
      request<{ document: { id: string; filename: string; status: string } }>(
        urlPath`/api/instances/${slug}/knowledge`,
        json("POST", data),
      ),
    /** Off keeps the document stored; retrieval skips it until it is switched on. */
    setEnabled: (slug: string, docId: string, enabled: boolean) =>
      request<{ id: string; enabled: boolean }>(
        urlPath`/api/instances/${slug}/knowledge/${docId}`,
        json("PATCH", { enabled }),
      ),
    delete: (slug: string, docId: string) =>
      request<{ deleted: boolean }>(
        urlPath`/api/instances/${slug}/knowledge/${docId}`,
        { method: "DELETE" },
      ),
    export: (slug: string) =>
      request<{
        version: number;
        instanceSlug: string;
        documents: { filename: string; content: string; mimeType: string; source: string; contentHash: string; enabled: boolean }[];
      }>(urlPath`/api/instances/${slug}/knowledge/export`),
    import: (slug: string, data: { version?: number; documents: { filename: string; content: string; enabled?: boolean }[] }) =>
      request<{ imported: number; documents: { filename: string; renamedFrom?: string }[] }>(
        urlPath`/api/instances/${slug}/knowledge/import`,
        json("POST", data),
      ),
  },
  analytics: {
    global: (from: string, to: string) => {
      return request<AnalyticsResponse>(withQuery("/api/analytics", { from, to }));
    },
    instance: (slug: string, from: string, to: string) => {
      return request<AnalyticsResponse>(withQuery(urlPath`/api/instances/${slug}/analytics`, { from, to }));
    },
  },
  conversations: {
    list: (params?: {
      instanceId?: string;
      source?: string;
      search?: string;
      /** Substring of the contact (email, phone number, channel handle). */
      userIdentifier?: string;
      limit?: number;
      offset?: number;
    }) => {
      return request<{
        conversations: ConversationListItem[];
        total: number;
        limit: number;
        offset: number;
      }>(withQuery("/api/conversations", params ?? {}));
    },
    get: (conversationId: string, instanceId: string) =>
      request<{ conversation: ConversationListItem }>(
        urlPath`/api/conversations/${conversationId}?instanceId=${instanceId}`,
      ),
    /**
     * SSE URL following one conversation live: its activity events, plus a
     * `persisted` event whenever a message or hook execution is stored.
     * EventSource cannot go through `request()`, so only the path lives here.
     */
    liveUrl: (conversationId: string, instanceId: string) =>
      withQuery("/api/activity-stream/conversation", { conversationId, instanceId }),
    hookExecutions: (conversationId: string, instanceId: string) =>
      request<{ executions: HookExecution[] }>(
        urlPath`/api/conversations/${conversationId}/hooks?instanceId=${instanceId}`,
      ),
    messages: (
      conversationId: string,
      instanceId: string,
      params?: { limit?: number; offset?: number; order?: "asc" | "desc" },
    ) => {
      return request<{
        messages: ConversationMessage[];
        total: number;
        limit: number;
        offset: number;
        order: "asc" | "desc";
      }>(withQuery(urlPath`/api/conversations/${conversationId}/messages`, { instanceId, ...params }));
    },
    /** Heavy per-turn debug data (captured LLM request payload + step trace) for one message. */
    messageDebug: (conversationId: string, messageId: string, instanceId: string) =>
      request<MessageDebug>(
        urlPath`/api/conversations/${conversationId}/messages/${messageId}/debug?instanceId=${instanceId}`,
      ),
    /** The conversation state store snapshot (latest; includes the `_channel` identity). */
    state: (conversationId: string, instanceId: string) =>
      request<{ state: Record<string, unknown> }>(
        urlPath`/api/conversations/${conversationId}/state?instanceId=${instanceId}`,
      ),
    delete: (conversationId: string, instanceId: string) =>
      request<{ deleted: boolean }>(
        urlPath`/api/conversations/${conversationId}?instanceId=${instanceId}`,
        { method: "DELETE" },
      ),
    /** Rename the conversation id (propagated across all linked tables) and/or its title. */
    rename: (
      conversationId: string,
      instanceId: string,
      body: { conversationId?: string; title?: string },
    ) =>
      request<{ renamed: boolean; conversationId: string }>(
        urlPath`/api/conversations/${conversationId}?instanceId=${instanceId}`,
        json("PATCH", body),
      ),
  },
  memories: {
    list: (params?: {
      instanceId?: string;
      search?: string;
      category?: string;
      limit?: number;
      offset?: number;
    }) => {
      return request<{
        memories: Memory[];
        total: number;
        limit: number;
        offset: number;
      }>(withQuery("/memories", params ?? {}));
    },
    create: (data: { instanceId: string; content: string; category?: string; importance?: number }) =>
      request<{ memory: { id: string; content: string; event: string } }>("/memories", json("POST", data)),
    delete: (id: string) =>
      request<{ deleted: boolean }>(urlPath`/memories/${id}`, {
        method: "DELETE",
      }),
    deleteAll: (instanceId: string) =>
      request<{ deleted: boolean }>(urlPath`/memories?instanceId=${instanceId}`, {
        method: "DELETE",
      }),
  },
  skillLibrary: {
    list: () =>
      request<{ skills: LibrarySkillSummary[] }>("/api/skills"),
    get: (name: string) =>
      request<LibrarySkillDetail>(urlPath`/api/skills/${name}`),
    create: (data: {
      name: string;
      description: string;
      content: string;
      requiredEnv?: { name: string; description?: string; sensitive: boolean }[];
      requiredTools?: string[];
    }) =>
      request<LibrarySkillDetail>("/api/skills", json("POST", data)),
    update: (name: string, data: {
      /** Renames the skill for people; the slug in `name` is unchanged. */
      displayName?: string;
      description: string;
      content: string;
      requiredEnv?: { name: string; description?: string; sensitive: boolean }[];
      requiredTools?: string[];
      changelog?: string;
    }) =>
      request<LibrarySkillDetail>(urlPath`/api/skills/${name}`, json("PUT", data)),
    delete: (name: string) =>
      request<{ deleted: boolean }>(urlPath`/api/skills/${name}`, {
        method: "DELETE",
      }),
    versions: (name: string) =>
      request<{ versions: SkillVersion[] }>(urlPath`/api/skills/${name}/versions`),
    getVersion: (name: string, version: string) =>
      request<SkillVersion>(urlPath`/api/skills/${name}/versions/${version}`),
  },

  monitor: {
    /** One page of the Monitor timeline, newest first; pass `nextCursor` back for the next. */
    list: (params?: {
      types?: readonly string[];
      group?: string;
      agent?: string;
      outcome?: MonitorOutcome;
      from?: string;
      to?: string;
      q?: string;
      cursor?: string;
      limit?: number;
    }) => request<MonitorPage>(withQuery("/api/monitor", { ...params, types: params?.types?.join(",") })),
    detail: (type: string, id: string) =>
      request<MonitorDetail>(urlPath`/api/monitor/${type}/${id}`),
  },

  scheduledTasks: {
    list: (slug: string) =>
      request<{ tasks: ScheduledTask[] }>(
        urlPath`/api/instances/${slug}/scheduled-tasks`,
      ),
    get: (slug: string, id: string) =>
      request<{ task: ScheduledTask }>(
        urlPath`/api/instances/${slug}/scheduled-tasks/${id}`,
      ),
    create: (
      slug: string,
      data: {
        name: string;
        prompt: string;
        schedule: ScheduledTaskSchedule;
        description?: string;
        deleteAfterRun?: boolean;
        outboundChannel?: string | null;
        outboundTarget?: string | null;
        keepHistory?: boolean;
      },
    ) =>
      request<{ task: ScheduledTask }>(
        urlPath`/api/instances/${slug}/scheduled-tasks`,
        json("POST", data),
      ),
    update: (
      slug: string,
      id: string,
      data: {
        name?: string;
        description?: string;
        prompt?: string;
        schedule?: ScheduledTaskSchedule;
        enabled?: boolean;
        deleteAfterRun?: boolean;
        outboundChannel?: string | null;
        outboundTarget?: string | null;
        keepHistory?: boolean;
      },
    ) =>
      request<{ task: ScheduledTask }>(
        urlPath`/api/instances/${slug}/scheduled-tasks/${id}`,
        json("PATCH", data),
      ),
    delete: (slug: string, id: string) =>
      request<{ deleted: boolean }>(
        urlPath`/api/instances/${slug}/scheduled-tasks/${id}`,
        { method: "DELETE" },
      ),
    run: (slug: string, id: string) =>
      request<{ message: string }>(
        urlPath`/api/instances/${slug}/scheduled-tasks/${id}/run`,
        { method: "POST" },
      ),
    runs: (slug: string, params?: { taskId?: string; status?: string; limit?: number; offset?: number }) => {
      return request<{ runs: ScheduledTaskRun[]; total: number }>(
        withQuery(urlPath`/api/instances/${slug}/scheduled-tasks/runs`, params ?? {}),
      );
    },
  },

  hooks: {
    list: (slug: string) =>
      request<{ hooks: InstanceHook[] }>(
        urlPath`/api/instances/${slug}/hooks`,
      ),
    functions: () =>
      request<{ hookFunctions: HookFunctionInfo[] }>("/api/hook-functions"),
    create: (
      slug: string,
      data: {
        event: HookEvent;
        actionType?: "function";
        actionConfig: { functionName: string };
        enabled?: boolean;
        position?: number;
        timeoutMs?: number;
      },
    ) =>
      request<{ hook: InstanceHook }>(
        urlPath`/api/instances/${slug}/hooks`,
        json("POST", data),
      ),
    update: (
      slug: string,
      id: string,
      data: {
        event?: HookEvent;
        actionConfig?: { functionName: string };
        enabled?: boolean;
        position?: number;
        timeoutMs?: number;
      },
    ) =>
      request<{ hook: InstanceHook }>(
        urlPath`/api/instances/${slug}/hooks/${id}`,
        json("PATCH", data),
      ),
    delete: (slug: string, id: string) =>
      request<{ deleted: boolean }>(
        urlPath`/api/instances/${slug}/hooks/${id}`,
        { method: "DELETE" },
      ),
  },

  optouts: {
    list: (slug: string, params?: { status?: string; page?: number }) => {
      return request<{ optouts: OptoutContact[]; page: number }>(
        withQuery(urlPath`/api/instances/${slug}/optouts`, params ?? {}),
      );
    },
    optOut: (slug: string, channelType: string, channelId: string) =>
      request<{ ok: boolean }>(urlPath`/api/instances/${slug}/optouts`, json("POST", { channelType, channelId })),
    optIn: (slug: string, channelType: string, channelId: string) =>
      request<{ ok: boolean }>(
        urlPath`/api/instances/${slug}/optouts/${channelType}/${channelId}`,
        { method: "DELETE" },
      ),
  },

  room: {
    get: (slug: string) =>
      request<RoomConfigResponse>(urlPath`/api/instances/${slug}/room`),
    upsert: (slug: string, data: {
      enabled?: boolean;
      prompt?: string;
      outboundChannel?: string | null;
      outboundTarget?: string | null;
      evalIntervalMinutes?: number;
    }) =>
      request(urlPath`/api/instances/${slug}/room`, json("PUT", data)),
    delete: (slug: string) =>
      request(urlPath`/api/instances/${slug}/room`, { method: "DELETE" }),
    backlog: (slug: string, params?: { status?: string; limit?: number; offset?: number }) => {
      return request<{ events: BacklogEvent[]; total: number }>(
        withQuery(urlPath`/api/instances/${slug}/room/backlog`, { ...params, limit: params?.limit || undefined }),
      );
    },
    activity: (slug: string, params?: { logType?: string; limit?: number }) => {
      return request<ActivityLogEntry[]>(
        withQuery(urlPath`/api/instances/${slug}/room/activity`, { ...params, limit: params?.limit || undefined }),
      );
    },
  },

  exportImport: {
    exportInstance: async (slug: string) => {
      const res = await fetch(urlPath`${API_BASE}/api/instances/${slug}/export`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: res.statusText }));
        throw new ApiError(res.status, body.message ?? res.statusText);
      }
      return res.blob();
    },
    importNew: (bundle: unknown) =>
      request<{ slug: string; instanceId: string; warnings: { type: string; message: string }[] }>(
        "/api/instances/import",
        json("POST", bundle),
      ),
    importOverwrite: (slug: string, bundle: unknown) =>
      request<{ slug: string; instanceId: string; warnings: { type: string; message: string }[] }>(
        urlPath`/api/instances/${slug}/import`,
        json("POST", bundle),
      ),
    exportSkill: async (name: string) => {
      const res = await fetch(urlPath`${API_BASE}/api/skills/${name}/export`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: res.statusText }));
        throw new ApiError(res.status, body.message ?? res.statusText);
      }
      return res.blob();
    },
    exportSkills: async () => {
      const res = await fetch(`${API_BASE}/api/skills/catalog/export`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: res.statusText }));
        throw new ApiError(res.status, body.message ?? res.statusText);
      }
      return res.blob();
    },
    importSkills: (bundle: unknown) =>
      request<{ created: string[]; updated: string[]; skipped: string[] }>(
        "/api/skills/catalog/import",
        json("POST", bundle),
      ),
  },

  eventSources: {
    list: (slug: string) =>
      request<EventSource[]>(urlPath`/api/instances/${slug}/event-sources`),
    create: (slug: string, data: { name: string; sourceType: string; config: Record<string, unknown>; enabled?: boolean }) =>
      request<{ id: string; webhookToken: string; webhookUrl: string }>(urlPath`/api/instances/${slug}/event-sources`, json("POST", data)),
    update: (slug: string, id: string, data: { name?: string; config?: Record<string, unknown>; enabled?: boolean }) =>
      request(urlPath`/api/instances/${slug}/event-sources/${id}`, json("PUT", data)),
    delete: (slug: string, id: string) =>
      request(urlPath`/api/instances/${slug}/event-sources/${id}`, { method: "DELETE" }),
    rotateToken: (slug: string, id: string) =>
      request<{ webhookToken: string; webhookUrl: string }>(urlPath`/api/instances/${slug}/event-sources/${id}/rotate-token`, { method: "POST" }),
    // ROOM_WRITE only — the list endpoint above deliberately omits this
    // bearer-equivalent URL, so the caller fetches it on demand per source.
    webhookUrl: (slug: string, id: string) =>
      request<{ webhookUrl: string }>(
        urlPath`/api/instances/${slug}/event-sources/${id}/webhook-url`,
      ),
    listDefinitions: (slug: string, sourceId: string) =>
      request<EventDefinition[]>(urlPath`/api/instances/${slug}/event-sources/${sourceId}/definitions`),
    createDefinition: (slug: string, sourceId: string, data: { name: string; matchingPrompt: string; interpretationPrompt: string; enabled?: boolean }) =>
      request<{ id: string }>(urlPath`/api/instances/${slug}/event-sources/${sourceId}/definitions`, json("POST", data)),
    updateDefinition: (slug: string, sourceId: string, defId: string, data: { name?: string; matchingPrompt?: string; interpretationPrompt?: string; enabled?: boolean }) =>
      request(urlPath`/api/instances/${slug}/event-sources/${sourceId}/definitions/${defId}`, json("PUT", data)),
    deleteDefinition: (slug: string, sourceId: string, defId: string) =>
      request(urlPath`/api/instances/${slug}/event-sources/${sourceId}/definitions/${defId}`, { method: "DELETE" }),
  },
};
