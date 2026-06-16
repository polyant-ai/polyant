// SPDX-License-Identifier: AGPL-3.0-or-later

// Re-export all types for backward compatibility
export type {
  AdminUser,
  UserRole,
  CreateUserResponse,
  ResetPasswordResponse,
  Instance,
  SecretStatus,
  ChannelConfig,
  RoomConfigResponse,
  ModelInfo,
  ModelsResponse,
  PromptSection,
  ToolState,
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
  MessageDebug,
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
  AuditLogEntry,
  AuditLogListResult,
  AuditStatsResult,
  EventSource,
  EventDefinition,
  HookEvent,
  InstanceHook,
  HookExecution,
  BacklogEvent,
  ActivityLogEntry,
  OptoutContact,
  EmbeddingWipeResult,
} from "./api-types";

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
  AuditLogListResult,
  AuditStatsResult,
  EventSource,
  EventDefinition,
  HookEvent,
  InstanceHook,
  HookExecution,
  BacklogEvent,
  ActivityLogEntry,
  OptoutContact,
  EmbeddingWipeResult,
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
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...headers },
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

export const api = {
  users: {
    list: () => request<{ users: AdminUser[] }>("/api/users"),
    create: (data: { email: string; name?: string; role?: "superadmin" | "user"; password?: string }) =>
      request<CreateUserResponse>("/api/users", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    update: (id: string, data: { name?: string | null; role?: "superadmin" | "user" }) =>
      request<{ user: AdminUser }>(`/api/users/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      request<{ deleted: boolean }>(`/api/users/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    resetPassword: (id: string) =>
      request<ResetPasswordResponse>(`/api/users/${encodeURIComponent(id)}/reset-password`, {
        method: "POST",
      }),
  },
  me: {
    changePassword: (data: { currentPassword?: string; newPassword: string }) =>
      request<{ ok: boolean }>("/api/me/password", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  },
  instances: {
    list: () => request<{ instances: Instance[] }>("/api/instances"),
    get: (slug: string) =>
      request<{ instance: Instance }>(`/api/instances/${encodeURIComponent(slug)}`),
    create: (data: { slug: string; name: string; description?: string; provider?: string; model?: string }) =>
      request<{ instance: Instance }>("/api/instances", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    update: (
      slug: string,
      data: {
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
        stateInPromptEnabled?: boolean;
        toolResultsInHistoryEnabled?: boolean;
        debugEnabled?: boolean;
        sttProvider?: "openai" | "aws" | "deepgram";
        optoutEnabled?: boolean;
        optoutStopKeywords?: string[];
        optoutResumeKeywords?: string[];
        optoutClosingMessage?: string | null;
        optoutResumeMessage?: string | null;
        optoutInjectPromptHint?: boolean;
        /** Acknowledge the destructive memory/knowledge wipe on an embedding-provider switch. */
        confirmWipe?: boolean;
      },
    ) =>
      request<{ instance: Instance; wiped?: EmbeddingWipeResult | null }>(
        `/api/instances/${encodeURIComponent(slug)}`,
        {
          method: "PATCH",
          body: JSON.stringify(data),
        },
      ),
    delete: (slug: string) =>
      request<{ deleted: boolean }>(`/api/instances/${encodeURIComponent(slug)}`, {
        method: "DELETE",
      }),
    setIcon: (slug: string, icon: string) =>
      request<{ instance: Instance }>(`/api/instances/${encodeURIComponent(slug)}/icon`, {
        method: "PUT",
        body: JSON.stringify({ icon }),
      }),
    deleteIcon: (slug: string) =>
      request<{ instance: Instance }>(`/api/instances/${encodeURIComponent(slug)}/icon`, {
        method: "DELETE",
      }),
  },
  prompts: {
    list: (slug: string) =>
      request<{ prompts: PromptSection[] }>(`/api/instances/${encodeURIComponent(slug)}/prompts`),
    update: (slug: string, sections: { key: string; content: string }[]) =>
      request<{ prompts: PromptSection[] }>(`/api/instances/${encodeURIComponent(slug)}/prompts`, {
        method: "PATCH",
        body: JSON.stringify({ sections }),
      }),
  },
  tools: {
    list: (slug: string) =>
      request<{ tools: ToolState[] }>(`/api/instances/${encodeURIComponent(slug)}/tools`),
    update: (slug: string, enabled: string[]) =>
      request<{ tools: ToolState[] }>(`/api/instances/${encodeURIComponent(slug)}/tools`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      }),
    requiredSecrets: (slug: string) =>
      request<{ requiredSecrets: RequiredSecretSpec[] }>(`/api/instances/${encodeURIComponent(slug)}/tools/required-secrets`),
    catalog: () =>
      request<{ tools: ToolInfo[] }>("/api/tools"),
  },
  models: {
    list: () => request<ModelsResponse>("/api/instances/models"),
  },
  skills: {
    list: (slug: string) =>
      request<{ skills: SkillState[] }>(`/api/instances/${encodeURIComponent(slug)}/skills`),
    update: (slug: string, enabled: string[]) =>
      request<SkillUpdateResponse>(`/api/instances/${encodeURIComponent(slug)}/skills`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      }),
    upgrade: (slug: string, skillSlug: string) =>
      request<{ upgraded: boolean }>(`/api/instances/${encodeURIComponent(slug)}/skills/${encodeURIComponent(skillSlug)}/upgrade`, { method: "POST" }),
    rollback: (slug: string, skillSlug: string, versionId: string) =>
      request<{ rolledBack: boolean }>(`/api/instances/${encodeURIComponent(slug)}/skills/${encodeURIComponent(skillSlug)}/rollback`, { method: "POST", body: JSON.stringify({ versionId }) }),
    getEnv: (slug: string, skillSlug: string) =>
      request<{ env: SkillEnvStatus[] }>(
        `/api/instances/${encodeURIComponent(slug)}/skills/${encodeURIComponent(skillSlug)}/env`,
      ),
    setEnv: (
      slug: string,
      skillSlug: string,
      env: { key: string; value: string; sensitive: boolean }[],
    ) =>
      request<{ env: SkillEnvStatus[] }>(
        `/api/instances/${encodeURIComponent(slug)}/skills/${encodeURIComponent(skillSlug)}/env`,
        { method: "PUT", body: JSON.stringify({ env }) },
      ),
    setAutoLoad: (slug: string, skillSlug: string, autoLoad: boolean) =>
      request<{ autoLoad: boolean }>(
        `/api/instances/${encodeURIComponent(slug)}/skills/${encodeURIComponent(skillSlug)}/auto-load`,
        { method: "POST", body: JSON.stringify({ autoLoad }) },
      ),
  },
  secrets: {
    list: (slug: string) =>
      request<{ secrets: SecretStatus[] }>(`/api/instances/${encodeURIComponent(slug)}/secrets`),
    set: (slug: string, secrets: { key: string; value: string }[]) =>
      request<{ secrets: SecretStatus[] }>(`/api/instances/${encodeURIComponent(slug)}/secrets`, {
        method: "PUT",
        body: JSON.stringify({ secrets }),
      }),
    delete: (slug: string, key: string) =>
      request<{ deleted: boolean }>(`/api/instances/${encodeURIComponent(slug)}/secrets/${encodeURIComponent(key)}`, {
        method: "DELETE",
      }),
  },
  channels: {
    list: (slug: string) =>
      request<{ channels: ChannelConfig[] }>(`/api/instances/${encodeURIComponent(slug)}/channels`),
    set: (slug: string, channelType: string, config: Record<string, unknown>, enabled: boolean) =>
      request<{ channel: ChannelConfig | null }>(
        `/api/instances/${encodeURIComponent(slug)}/channels/${encodeURIComponent(channelType)}`,
        { method: "PUT", body: JSON.stringify({ config, enabled }) },
      ),
    delete: (slug: string, channelType: string) =>
      request<{ deleted: boolean }>(
        `/api/instances/${encodeURIComponent(slug)}/channels/${encodeURIComponent(channelType)}`,
        { method: "DELETE" },
      ),
  },
  knowledge: {
    list: (slug: string) =>
      request<{ documents: KnowledgeDocument[] }>(`/api/instances/${encodeURIComponent(slug)}/knowledge`),
    get: (slug: string, docId: string) =>
      request<{ document: KnowledgeDocumentDetail }>(
        `/api/instances/${encodeURIComponent(slug)}/knowledge/${encodeURIComponent(docId)}`,
      ),
    upload: (slug: string, data: { filename: string; content: string }) =>
      request<{ document: { id: string; filename: string; status: string } }>(
        `/api/instances/${encodeURIComponent(slug)}/knowledge`,
        { method: "POST", body: JSON.stringify(data) },
      ),
    delete: (slug: string, docId: string) =>
      request<{ deleted: boolean }>(
        `/api/instances/${encodeURIComponent(slug)}/knowledge/${encodeURIComponent(docId)}`,
        { method: "DELETE" },
      ),
  },
  analytics: {
    global: (from: string, to: string) => {
      const query = new URLSearchParams({ from, to });
      return request<AnalyticsResponse>(`/api/analytics?${query}`);
    },
    instance: (slug: string, from: string, to: string) => {
      const query = new URLSearchParams({ from, to });
      return request<AnalyticsResponse>(`/api/instances/${encodeURIComponent(slug)}/analytics?${query}`);
    },
  },
  conversations: {
    list: (params?: {
      instanceId?: string;
      source?: string;
      search?: string;
      limit?: number;
      offset?: number;
    }) => {
      const query = new URLSearchParams();
      if (params?.instanceId) query.set("instanceId", params.instanceId);
      if (params?.source) query.set("source", params.source);
      if (params?.search) query.set("search", params.search);
      if (params?.limit) query.set("limit", String(params.limit));
      if (params?.offset) query.set("offset", String(params.offset));
      const qs = query.toString();
      return request<{
        conversations: ConversationListItem[];
        total: number;
        limit: number;
        offset: number;
      }>(`/api/conversations${qs ? `?${qs}` : ""}`);
    },
    get: (conversationId: string, instanceId: string) =>
      request<{ conversation: ConversationListItem }>(
        `/api/conversations/${encodeURIComponent(conversationId)}?instanceId=${encodeURIComponent(instanceId)}`,
      ),
    hookExecutions: (conversationId: string, instanceId: string) =>
      request<{ executions: HookExecution[] }>(
        `/api/conversations/${encodeURIComponent(conversationId)}/hooks?instanceId=${encodeURIComponent(instanceId)}`,
      ),
    messages: (
      conversationId: string,
      instanceId: string,
      params?: { limit?: number; offset?: number; order?: "asc" | "desc" },
    ) => {
      const query = new URLSearchParams({ instanceId });
      if (params?.limit) query.set("limit", String(params.limit));
      if (params?.offset) query.set("offset", String(params.offset));
      if (params?.order) query.set("order", params.order);
      return request<{
        messages: ConversationMessage[];
        total: number;
        limit: number;
        offset: number;
        order: "asc" | "desc";
      }>(
        `/api/conversations/${encodeURIComponent(conversationId)}/messages?${query.toString()}`,
      );
    },
    /** Heavy per-turn debug data (captured LLM request payload + step trace) for one message. */
    messageDebug: (conversationId: string, messageId: string, instanceId: string) =>
      request<MessageDebug>(
        `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/debug?instanceId=${encodeURIComponent(instanceId)}`,
      ),
    /** The conversation state store snapshot (latest; includes the `_channel` identity). */
    state: (conversationId: string, instanceId: string) =>
      request<{ state: Record<string, unknown> }>(
        `/api/conversations/${encodeURIComponent(conversationId)}/state?instanceId=${encodeURIComponent(instanceId)}`,
      ),
    delete: (conversationId: string, instanceId: string) =>
      request<{ deleted: boolean }>(
        `/api/conversations/${encodeURIComponent(conversationId)}?instanceId=${encodeURIComponent(instanceId)}`,
        { method: "DELETE" },
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
      const query = new URLSearchParams();
      if (params?.instanceId) query.set("instanceId", params.instanceId);
      if (params?.search) query.set("search", params.search);
      if (params?.category) query.set("category", params.category);
      if (params?.limit) query.set("limit", String(params.limit));
      if (params?.offset) query.set("offset", String(params.offset));
      const qs = query.toString();
      return request<{
        memories: Memory[];
        total: number;
        limit: number;
        offset: number;
      }>(`/memories${qs ? `?${qs}` : ""}`);
    },
    create: (data: { instanceId: string; content: string; category?: string; importance?: number }) =>
      request<{ memory: { id: string; content: string; event: string } }>("/memories", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      request<{ deleted: boolean }>(`/memories/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    deleteAll: (instanceId: string) =>
      request<{ deleted: boolean }>(`/memories?instanceId=${encodeURIComponent(instanceId)}`, {
        method: "DELETE",
      }),
  },
  skillLibrary: {
    list: () =>
      request<{ skills: LibrarySkillSummary[] }>("/api/skills"),
    get: (name: string) =>
      request<LibrarySkillDetail>(`/api/skills/${encodeURIComponent(name)}`),
    create: (data: {
      name: string;
      description: string;
      content: string;
      requiredEnv?: { name: string; description?: string; sensitive: boolean }[];
      requiredTools?: string[];
    }) =>
      request<LibrarySkillDetail>("/api/skills", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    update: (name: string, data: {
      description: string;
      content: string;
      requiredEnv?: { name: string; description?: string; sensitive: boolean }[];
      requiredTools?: string[];
      changelog?: string;
    }) =>
      request<LibrarySkillDetail>(`/api/skills/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    delete: (name: string) =>
      request<{ deleted: boolean }>(`/api/skills/${encodeURIComponent(name)}`, {
        method: "DELETE",
      }),
    versions: (name: string) =>
      request<{ versions: SkillVersion[] }>(`/api/skills/${encodeURIComponent(name)}/versions`),
    getVersion: (name: string, version: string) =>
      request<SkillVersion>(`/api/skills/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`),
  },

  auditLogs: {
    list: (params?: {
      instanceId?: string;
      toolName?: string;
      action?: string;
      search?: string;
      from?: string;
      to?: string;
      limit?: number;
      offset?: number;
    }) => {
      const query = new URLSearchParams();
      if (params?.instanceId) query.set("instanceId", params.instanceId);
      if (params?.toolName) query.set("toolName", params.toolName);
      if (params?.action) query.set("action", params.action);
      if (params?.search) query.set("search", params.search);
      if (params?.from) query.set("from", params.from);
      if (params?.to) query.set("to", params.to);
      if (params?.limit) query.set("limit", String(params.limit));
      if (params?.offset) query.set("offset", String(params.offset));
      const qs = query.toString();
      return request<AuditLogListResult>(`/api/audit-logs${qs ? `?${qs}` : ""}`);
    },
    stats: (params?: {
      instanceId?: string;
      from?: string;
      to?: string;
    }) => {
      const query = new URLSearchParams();
      if (params?.instanceId) query.set("instanceId", params.instanceId);
      if (params?.from) query.set("from", params.from);
      if (params?.to) query.set("to", params.to);
      const qs = query.toString();
      return request<AuditStatsResult>(`/api/audit-logs/stats${qs ? `?${qs}` : ""}`);
    },
  },

  scheduledTasks: {
    list: (slug: string) =>
      request<{ tasks: ScheduledTask[] }>(
        `/api/instances/${encodeURIComponent(slug)}/scheduled-tasks`,
      ),
    get: (slug: string, id: string) =>
      request<{ task: ScheduledTask }>(
        `/api/instances/${encodeURIComponent(slug)}/scheduled-tasks/${encodeURIComponent(id)}`,
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
        `/api/instances/${encodeURIComponent(slug)}/scheduled-tasks`,
        { method: "POST", body: JSON.stringify(data) },
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
        `/api/instances/${encodeURIComponent(slug)}/scheduled-tasks/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify(data) },
      ),
    delete: (slug: string, id: string) =>
      request<{ deleted: boolean }>(
        `/api/instances/${encodeURIComponent(slug)}/scheduled-tasks/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ),
    run: (slug: string, id: string) =>
      request<{ message: string }>(
        `/api/instances/${encodeURIComponent(slug)}/scheduled-tasks/${encodeURIComponent(id)}/run`,
        { method: "POST" },
      ),
    runs: (slug: string, params?: { taskId?: string; status?: string; limit?: number; offset?: number }) => {
      const qs = new URLSearchParams();
      if (params?.taskId) qs.set("taskId", params.taskId);
      if (params?.status) qs.set("status", params.status);
      if (params?.limit) qs.set("limit", String(params.limit));
      if (params?.offset) qs.set("offset", String(params.offset));
      const query = qs.toString();
      return request<{ runs: ScheduledTaskRun[]; total: number }>(
        `/api/instances/${encodeURIComponent(slug)}/scheduled-tasks/runs${query ? `?${query}` : ""}`,
      );
    },
  },

  hooks: {
    list: (slug: string) =>
      request<{ hooks: InstanceHook[] }>(
        `/api/instances/${encodeURIComponent(slug)}/hooks`,
      ),
    create: (
      slug: string,
      data: {
        event: HookEvent;
        actionType?: "tool";
        actionConfig: { toolName: string; args: Record<string, unknown> };
        enabled?: boolean;
        position?: number;
        timeoutMs?: number;
      },
    ) =>
      request<{ hook: InstanceHook }>(
        `/api/instances/${encodeURIComponent(slug)}/hooks`,
        { method: "POST", body: JSON.stringify(data) },
      ),
    update: (
      slug: string,
      id: string,
      data: {
        event?: HookEvent;
        actionConfig?: { toolName: string; args: Record<string, unknown> };
        enabled?: boolean;
        position?: number;
        timeoutMs?: number;
      },
    ) =>
      request<{ hook: InstanceHook }>(
        `/api/instances/${encodeURIComponent(slug)}/hooks/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify(data) },
      ),
    delete: (slug: string, id: string) =>
      request<{ deleted: boolean }>(
        `/api/instances/${encodeURIComponent(slug)}/hooks/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ),
  },

  optouts: {
    list: (slug: string, params?: { status?: string; page?: number }) => {
      const q = new URLSearchParams();
      if (params?.status) q.set("status", params.status);
      if (params?.page) q.set("page", String(params.page));
      const qs = q.toString();
      return request<{ optouts: OptoutContact[]; page: number }>(
        `/api/instances/${encodeURIComponent(slug)}/optouts${qs ? `?${qs}` : ""}`,
      );
    },
    optOut: (slug: string, channelType: string, channelId: string) =>
      request<{ ok: boolean }>(`/api/instances/${encodeURIComponent(slug)}/optouts`, {
        method: "POST",
        body: JSON.stringify({ channelType, channelId }),
      }),
    optIn: (slug: string, channelType: string, channelId: string) =>
      request<{ ok: boolean }>(
        `/api/instances/${encodeURIComponent(slug)}/optouts/${encodeURIComponent(channelType)}/${encodeURIComponent(channelId)}`,
        { method: "DELETE" },
      ),
  },

  room: {
    get: (slug: string) =>
      request<RoomConfigResponse>(`/api/instances/${encodeURIComponent(slug)}/room`),
    upsert: (slug: string, data: {
      enabled?: boolean;
      prompt?: string;
      outboundChannel?: string | null;
      outboundTarget?: string | null;
      evalIntervalMinutes?: number;
    }) =>
      request(`/api/instances/${encodeURIComponent(slug)}/room`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    delete: (slug: string) =>
      request(`/api/instances/${encodeURIComponent(slug)}/room`, { method: "DELETE" }),
    backlog: (slug: string, params?: { status?: string; limit?: number; offset?: number }) => {
      const qs = new URLSearchParams();
      if (params?.status) qs.set("status", params.status);
      if (params?.limit) qs.set("limit", String(params.limit));
      if (params?.offset) qs.set("offset", String(params.offset));
      const query = qs.toString() ? `?${qs.toString()}` : "";
      return request<{ events: BacklogEvent[]; total: number }>(`/api/instances/${encodeURIComponent(slug)}/room/backlog${query}`);
    },
    activity: (slug: string, params?: { logType?: string; limit?: number }) => {
      const qs = new URLSearchParams();
      if (params?.logType) qs.set("logType", params.logType);
      if (params?.limit) qs.set("limit", String(params.limit));
      const query = qs.toString() ? `?${qs.toString()}` : "";
      return request<ActivityLogEntry[]>(`/api/instances/${encodeURIComponent(slug)}/room/activity${query}`);
    },
  },

  exportImport: {
    exportInstance: async (slug: string) => {
      const res = await fetch(`${API_BASE}/api/instances/${encodeURIComponent(slug)}/export`, {
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
        { method: "POST", body: JSON.stringify(bundle) },
      ),
    importOverwrite: (slug: string, bundle: unknown) =>
      request<{ slug: string; instanceId: string; warnings: { type: string; message: string }[] }>(
        `/api/instances/${encodeURIComponent(slug)}/import`,
        { method: "POST", body: JSON.stringify(bundle) },
      ),
    exportSkill: async (name: string) => {
      const res = await fetch(`${API_BASE}/api/skills/${encodeURIComponent(name)}/export`, {
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
        { method: "POST", body: JSON.stringify(bundle) },
      ),
  },

  eventSources: {
    list: (slug: string) =>
      request<EventSource[]>(`/api/instances/${encodeURIComponent(slug)}/event-sources`),
    create: (slug: string, data: { name: string; sourceType: string; config: Record<string, unknown>; enabled?: boolean }) =>
      request<{ id: string; webhookToken: string; webhookUrl: string }>(`/api/instances/${encodeURIComponent(slug)}/event-sources`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    update: (slug: string, id: string, data: { name?: string; config?: Record<string, unknown>; enabled?: boolean }) =>
      request(`/api/instances/${encodeURIComponent(slug)}/event-sources/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    delete: (slug: string, id: string) =>
      request(`/api/instances/${encodeURIComponent(slug)}/event-sources/${id}`, { method: "DELETE" }),
    rotateToken: (slug: string, id: string) =>
      request<{ webhookToken: string; webhookUrl: string }>(`/api/instances/${encodeURIComponent(slug)}/event-sources/${id}/rotate-token`, { method: "POST" }),
    listDefinitions: (slug: string, sourceId: string) =>
      request<EventDefinition[]>(`/api/instances/${encodeURIComponent(slug)}/event-sources/${sourceId}/definitions`),
    createDefinition: (slug: string, sourceId: string, data: { name: string; matchingPrompt: string; interpretationPrompt: string; enabled?: boolean }) =>
      request<{ id: string }>(`/api/instances/${encodeURIComponent(slug)}/event-sources/${sourceId}/definitions`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    updateDefinition: (slug: string, sourceId: string, defId: string, data: { name?: string; matchingPrompt?: string; interpretationPrompt?: string; enabled?: boolean }) =>
      request(`/api/instances/${encodeURIComponent(slug)}/event-sources/${sourceId}/definitions/${defId}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    deleteDefinition: (slug: string, sourceId: string, defId: string) =>
      request(`/api/instances/${encodeURIComponent(slug)}/event-sources/${sourceId}/definitions/${defId}`, { method: "DELETE" }),
  },
};
