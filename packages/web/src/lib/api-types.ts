// SPDX-License-Identifier: AGPL-3.0-or-later

// ── Users ───────────────────────────────────────────────────────────

export type UserRole = "superadmin" | "user";

export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  role: UserRole;
  mustChangePassword: boolean;
  hasPassword: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CreateUserResponse {
  user: AdminUser;
  generatedPassword?: string;
}

export interface ResetPasswordResponse {
  user: AdminUser;
  generatedPassword: string;
}

// ── Instances ───────────────────────────────────────────────────────

export interface Instance {
  id: string;
  slug: string;
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
   * User preference for extended thinking on the model. Persisted as-is
   * across model changes; the engine's runtime gate ignores it when the
   * selected model is not thinking-capable.
   */
  thinkingEnabled: boolean;
  /** When true, the conversation state store is rendered read-only into the system prompt. */
  stateInPromptEnabled: boolean;
  /** When true, prior-turn tool results are replayed (truncated) into the model's history. */
  toolResultsInHistoryEnabled: boolean;
  /** When true, the exact LLM request payload is persisted per turn (debug/analysis). */
  debugEnabled: boolean;
  /** When true, inbound STOP/START keyword handling is active for this instance. */
  optoutEnabled: boolean;
  optoutStopKeywords: string[];
  optoutResumeKeywords: string[];
  optoutClosingMessage: string | null;
  optoutResumeMessage: string | null;
  /** When true, a read-only opt-out hint is injected into the supervisor prompt. */
  optoutInjectPromptHint: boolean;
  sttProvider: string | null;
  icon: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface SecretStatus {
  key: string;
  configured: boolean;
}

export interface ChannelConfig {
  channelType: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface RoomConfigResponse {
  configured: boolean;
  id?: string;
  enabled?: boolean;
  prompt?: string;
  outboundChannel?: string | null;
  outboundTarget?: string | null;
  evalIntervalMinutes?: number;
  pendingEventCount?: number;
}

export interface ModelInfo {
  id: string;
  tier: string | null;
  costInput: number;
  costOutput: number;
  /**
   * True when the model supports extended thinking / reasoning.
   * Computed server-side from `isThinkingCapable(provider, modelId)`; the
   * frontend uses this to decide whether to show the "Extended thinking"
   * toggle in the instance settings.
   */
  supportsThinking: boolean;
}

export interface ModelsResponse {
  providers: Record<string, { models: ModelInfo[] }>;
}

export interface PromptSection {
  key: string;
  filename: string;
  title: string;
  content: string;
}

/** Per-instance config field declared by a tool. `text` is a masked input; `select` renders a dropdown over `choices`. */
export interface RequiredSecretSpec {
  key: string;
  type: "text" | "select";
  label?: string;
  description?: string;
  choices?: string[];
  optional?: boolean;
  /** false → readable value (shown in cleartext, prefilled from `currentValue`); true/undefined → secret (masked input). */
  sensitive?: boolean;
  /** Cleartext value for non-sensitive fields (so the UI can preselect or prefill). Never present for sensitive fields. */
  currentValue?: string;
}

export interface ToolState {
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  requiredSecrets?: RequiredSecretSpec[];
  source?: "global" | "skill" | "manual";
  requiredBy?: string[];
}

export interface RequiredEnvEntry {
  name: string;
  description?: string;
  sensitive: boolean;
}

export interface SkillState {
  name: string;
  description: string;
  enabled: boolean;
  autoLoad?: boolean;
  category?: string;
  requiredEnv?: RequiredEnvEntry[];
  requiredTools?: string[];
  envConfigured?: boolean;
  pinnedVersion?: string;
  currentVersion?: string;
  hasUpdate?: boolean;
}

export interface SkillUpdateResponse {
  skills: SkillState[];
  toolsChanged?: {
    added: string[];
    removed: string[];
  };
}

export interface SkillEnvStatus {
  key: string;
  value: string;
  sensitive: boolean;
  configured: boolean;
  description?: string;
}

// ── Skill Library (global) ───────────────────────────────────────────

export interface LibrarySkillSummary {
  name: string;
  description: string;
  category?: string;
  requiredEnv?: RequiredEnvEntry[];
  requiredTools?: string[];
}

export interface LibrarySkillDetail {
  name: string;
  description: string;
  category?: string;
  requiredEnv?: RequiredEnvEntry[];
  requiredTools?: string[];
  content: string;
}

export interface SkillVersion {
  id: string;
  skillId: string;
  version: string;
  content: string;
  metadata: Record<string, unknown>;
  scripts: Array<{ file: string; description: string; content: string }>;
  changelog: string | null;
  createdAt: string;
}

// ── Scheduled Tasks ──────────────────────────────────────────────────

export interface ScheduledTaskSchedule {
  type: "cron" | "interval" | "one-shot";
  expression?: string;
  timezone?: string;
  everyMs?: number;
  anchorAt?: string;
  runAt?: string;
}

export interface ScheduledTask {
  id: string;
  name: string;
  description: string | null;
  schedule: ScheduledTaskSchedule;
  scheduleHuman: string;
  prompt: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastError: string | null;
  lastConversationId: string | null;
  consecutiveErrors: number;
  totalRuns: number;
  deleteAfterRun: boolean;
  maxRetries: number;
  outboundChannel: string | null;
  outboundTarget: string | null;
  keepHistory: boolean;
  createdBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  taskName: string;
  status: "running" | "success" | "error";
  triggerType: "scheduled" | "manual";
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  output: string | null;
  error: string | null;
  toolCalls: Array<{ name: string; args?: Record<string, unknown>; durationMs?: number }>;
  tokenUsage: { promptTokens?: number; completionTokens?: number };
  conversationId: string | null;
}

// ── Conversations ─────────────────────────────────────────────────────

export interface ConversationListItem {
  id: string;
  conversationId: string;
  title: string | null;
  summary: string | null;
  channel: string | null;
  instanceId: string | null;
  instanceName: string | null;
  messageCount: number;
  totalTokens: number;
  totalCost: number;
  conversationTokens: number;
  conversationCost: number;
  serviceTokens: number;
  serviceCost: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ConversationSearchResult extends ConversationListItem {
  matchCount: number;
  bestSnippet: string;
}

export interface AttachmentMeta {
  type: "image" | "file" | "audio" | "video";
  mimeType?: string;
  fileName?: string;
  s3Key: string;
  sizeBytes?: number;
}

export type ReasoningDetail =
  | { type: "text"; text: string; signature?: string }
  | { type: "redacted"; data: string };

/** One step of a multi-step assistant turn (assistant → tool → assistant → …). */
export interface StepDetail {
  index: number;
  stepType: "initial" | "continue" | "tool-result";
  text: string;
  toolCalls: { toolCallId: string; toolName: string; args: unknown }[];
  toolResults?: { toolCallId: string; result: unknown }[];
  reasoning?: ReasoningDetail[];
  finishReason: string;
  promptTokens?: number;
  completionTokens?: number;
  durationMs: number;
  /** True for rows backfilled from the legacy `tool_calls` shape (no real timing/reasoning). */
  legacy?: boolean;
}

export interface ConversationMessage {
  id: string;
  role: string;
  content: string;
  /** Per-step trace (replaces the legacy `toolCalls` flat array). */
  steps: StepDetail[] | null;
  /** Aggregated message-level reasoning (Anthropic signed thinking blocks, OpenAI summary). */
  reasoning: ReasoningDetail[] | null;
  attachments: AttachmentMeta[] | null;
  metadata: Record<string, unknown> | null;
  createdAt: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
}

/**
 * Exact LLM request payload captured for an assistant turn when the instance's
 * DEBUG flag was on. Heavy, fetched on-demand via the per-message debug endpoint.
 */
export interface LlmDebugPayload {
  system: string;
  messages: unknown[];
  tools: { name: string; description?: string; parameters?: unknown }[];
}

/** Response of GET /api/conversations/:id/messages/:messageId/debug. */
export interface MessageDebug {
  /** Null when the turn was generated with DEBUG off. */
  debugPayload: LlmDebugPayload | null;
  /** Per-step tool trace for the turn (always present for tool-using turns). */
  steps: StepDetail[] | null;
}

// ── Memories ──────────────────────────────────────────────────────────

export interface Memory {
  id: string;
  instanceId: string;
  content: string;
  category: string;
  importance: number;
  sourceConversationId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

// ── Analytics ─────────────────────────────────────────────────────────

export interface AnalyticsOverview {
  totalCost: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  totalConversations: number;
  totalMessages: number;
  uniqueUsers: number;
  avgCostPerConversation: number;
  avgResponseTime: number;
  trends: {
    cost: number;
    conversations: number;
    messages: number;
    responseTime: number;
  };
}

export interface DailyTrendRow {
  date: string;
  cost: number;
  tokens: number;
  conversations: number;
  messages: number;
}

export interface HourlyRow {
  hour: number;
  count: number;
}

export interface ChannelRow {
  channel: string;
  conversations: number;
  messages: number;
}

export interface ModelRow {
  provider: string;
  model: string;
  calls: number;
  tokens: number;
  cost: number;
  avgDuration: number;
}

export interface TierRow {
  tier: string;
  calls: number;
  tokens: number;
  cost: number;
}

export interface ToolRow {
  tool: string;
  count: number;
}

export interface InstanceComparisonRow {
  instanceId: string;
  name: string;
  conversations: number;
  cost: number;
  tokens: number;
}

// ── Latency Analytics ─────────────────────────────────────────────────

export interface LatencyOverview {
  p50: number;
  p95: number;
  p99: number;
  avgTotal: number;
  avgTtfb: number | null;
  sampleCount: number;
}

export interface LatencyDailyRow {
  date: string;
  p50: number;
  p95: number;
  p99: number;
}

export interface PhaseBreakdownRow {
  date: string;
  contextPrep: number;
  toolBuilding: number;
  llmCall: number;
}

export interface ToolLatencyRow {
  tool: string;
  avgDurationMs: number;
  callCount: number;
  p95: number;
  successRate: number;
}

export interface LatencyData {
  overview: LatencyOverview;
  dailyLatency: LatencyDailyRow[];
  phaseBreakdown: PhaseBreakdownRow[];
  slowestTools: ToolLatencyRow[];
}

export interface AnalyticsResponse {
  overview: AnalyticsOverview;
  dailyTrend: DailyTrendRow[];
  hourlyDistribution: HourlyRow[];
  channelDistribution: ChannelRow[];
  modelDistribution: ModelRow[];
  tierDistribution: TierRow[];
  toolUsage: ToolRow[];
  instanceComparison?: InstanceComparisonRow[];
  latency?: LatencyData;
}

export interface ToolInfo {
  name: string;
  description: string;
  category: string;
}

// ── Knowledge ───────────────────────────────────────────────────────

export interface KnowledgeDocument {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  source: "workspace" | "upload";
  status: "uploading" | "processing" | "ready" | "error";
  chunkCount: number;
  errorMessage: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface KnowledgeDocumentDetail extends KnowledgeDocument {
  rawContent: string;
}

// ── Audit Logs ─────────────────────────────────────────────────────

export interface AuditLogEntry {
  id: string;
  instanceId: string;
  conversationId: string | null;
  toolName: string;
  action: string;
  details: Record<string, unknown>;
  success: boolean;
  error: string | null;
  durationMs: number | null;
  output: string | null;
  createdAt: string;
}

export interface AuditLogListResult {
  items: AuditLogEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface AuditStatsResult {
  totalEntries: number;
  errorCount: number;
  errorRate: number;
  byTool: Array<{ toolName: string; count: number }>;
  byAction: Array<{ action: string; count: number }>;
}

// ── Event Sources & Room ──────────────────────────────────────────

export interface EventDefinition {
  id: string;
  name: string;
  matchingPrompt: string;
  interpretationPrompt: string;
  action: string;
  contextPrompt: string | null;
  outboundChannel: string | null;
  outboundTarget: string | null;
  enabled: boolean;
}

export interface EventSource {
  id: string;
  name: string;
  sourceType: string;
  enabled: boolean;
  webhookUrl: string;
  webhookToken: string;
  definitions: EventDefinition[];
}

export type HookEvent =
  | "conversation_start"
  | "message_received"
  | "response_generated"
  | "response_sent";

export interface InstanceHook {
  id: string;
  event: HookEvent;
  actionType: "tool";
  actionConfig: { toolName: string; args: Record<string, unknown> };
  enabled: boolean;
  position: number;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface HookExecution {
  id: string;
  hookId: string;
  event: HookEvent;
  actionType: "tool";
  toolName: string;
  success: boolean;
  error: string | null;
  durationMs: number;
  /** Rendered tool args (post-template). */
  args: Record<string, unknown> | null;
  /** Tool result, JSON-stringified and truncated. */
  result: string | null;
  createdAt: string;
}

export interface BacklogEvent {
  id: string;
  status: string;
  rawPayload: unknown;
  createdAt: string;
  reactNotes: string | null;
}

export interface ActivityLogEntry {
  id: string;
  logDate: string;
  logType: string;
  content: string;
  eventCount: number;
  createdAt: string;
}

// ── Opt-Out (GDPR) ────────────────────────────────────────────────────

export interface OptoutContact {
  channelType: string;
  channelId: string;
  status: "opted_out" | "opted_in";
  source: string;
  updatedAt: string | null;
}
