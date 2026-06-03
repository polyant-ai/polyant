// SPDX-License-Identifier: AGPL-3.0-or-later

import "reflect-metadata";
import { installFileLogger, shutdownFileLogger } from "./utils/file-logger.js";
installFileLogger();

import { config, DEFAULT_INSTANCE_ID } from "./config.js";
import { db } from "./database/client.js";
import { initAIGateway, shutdown as shutdownGateway } from "./ai-gateway/index.js";
import { initMemory } from "./memory/index.js";
import { resetStuckProcessingAll } from "./knowledge/store.js";
import { resetStuckProcessingEvents } from "./webhooks/webhook-backlog.store.js";
import { supervise, superviseStream } from "./agents/supervisor/index.js";
import { channelManager } from "./channels/channel-manager.js";
import { listAllInstances } from "./instances/store.js";
import { startServer } from "./server/main.js";
import { type AgentCallMetadata, type IncomingMessage, type OutgoingMessage, type StreamOutgoingMessage } from "./channels/types.js";
import { pipelineLog } from "./utils/pipeline-logger.js";
import { loadAllTools, getToolRegistry } from "./agents/tools/registry.js";
import { syncToolsToDb } from "./agents/tools/tools-sync.js";
import { traceStore } from "./analytics/trace.store.js";
import { auditStore } from "./audit/audit.store.js";
import { seedInitialAdmin } from "./users/seed.js";
import { schedulerService } from "./scheduled-tasks/scheduler.service.js";
import { roomScheduler } from "./room/room-scheduler.js";
import { getRoomBySlug, type RoomConfig } from "./room/room.store.js";
import { getActiveTrigger } from "./webhooks/active-triggers.js";
import { findActiveTaskByOutbound } from "./scheduled-tasks/store.js";
import { isPlatformStorageConfigured } from "./attachments/platform-storage.js";
import { TtlCache } from "./utils/ttl-cache.js";
import {
  isMissingApiKeyError,
  MISSING_KEY_RESPONSE,
  runPipelinePre,
  runPipelinePost,
} from "./pipeline.js";

// ---------------------------------------------------------------------------
// Module-level caches (kept in index.ts — they depend on DB lookups)
// ---------------------------------------------------------------------------

// Cached room lookup to avoid 2 DB queries per incoming message
const roomCache = new TtlCache<string, RoomConfig | null>({ maxSize: 500, ttlMs: 30_000 });

async function getCachedRoom(slug: string): Promise<RoomConfig | null> {
  if (roomCache.has(slug)) return roomCache.get(slug)!;
  const room = await getRoomBySlug(slug);
  roomCache.set(slug, room);
  return room;
}

// Cached outbound-task lookup to avoid DB query on every incoming message
type TaskOutboundResult = { lastConversationId: string | null } | null | undefined;
const taskOutboundCache = new TtlCache<string, TaskOutboundResult>({ maxSize: 500, ttlMs: 30_000 });

async function getCachedTaskOutbound(
  instanceId: string,
  channelType: string,
  channelId: string,
): Promise<TaskOutboundResult> {
  const key = `${instanceId}:${channelType}:${channelId}`;
  if (taskOutboundCache.has(key)) return taskOutboundCache.get(key);
  const result = await findActiveTaskByOutbound(instanceId, channelType, channelId);
  taskOutboundCache.set(key, result);
  return result;
}

/**
 * Format `postgresql://user:password@host:port/db` as `db @ host:port (user)`
 * for the boot summary. The password is NEVER included. Falls back to the
 * raw URL with the password masked if parsing fails.
 */
function formatDbTarget(databaseUrl: string): string {
  try {
    const u = new URL(databaseUrl);
    const dbName = u.pathname.replace(/^\//, "") || "(default)";
    const port = u.port || "5432";
    const user = u.username ? ` (${decodeURIComponent(u.username)})` : "";
    return `${dbName} @ ${u.hostname}:${port}${user}`;
  } catch {
    // Last-resort masking — never let a raw password reach stdout.
    return databaseUrl.replace(/:\/\/([^:]+):[^@]+@/, "://$1:****@");
  }
}

// ---------------------------------------------------------------------------
// main()
// ---------------------------------------------------------------------------

async function main() {
  console.log("Polyant starting...");

  // 0. Seed initial superadmin if the users table is empty (idempotent).
  // Runs before the rest of the boot so the system is "ready for first
  // access" the moment the server is up.
  try {
    await seedInitialAdmin();
  } catch (err) {
    console.error("[users] Initial admin seed failed:", err);
  }

  // 1. Initialize AI Gateway (logging + LangSmith) + Trace Store
  initAIGateway(db);
  traceStore.initialize(db);
  auditStore.initialize(db);

  // 1b. Load tool registry (auto-discover *.tool.ts files)
  await loadAllTools();
  console.log("Tool registry loaded");

  // 1b-i. Check platform S3 configuration
  if (!isPlatformStorageConfigured()) {
    console.warn("Platform S3 not configured (PLATFORM_S3_BUCKET) — file attachments will NOT be persisted");
  }

  // 1b-ii. Sync tool registry to DB
  await syncToolsToDb();
  console.log("Tool registry synced to DB");

  // 2. (Instances are managed via the admin panel — no auto-seeding)

  // 3. Initialize memory layer (pgvector)
  const pgvectorStatus = await initMemory();

  // 3a. Recover knowledge documents stuck in "processing" from a previous crash
  try {
    const reset = await resetStuckProcessingAll();
    if (reset > 0) {
      console.log(`[Knowledge] Reset ${reset} stale processing doc(s) to error`);
    }
  } catch (err) {
    console.error(
      "[Knowledge] Boot cleanup failed (non-fatal):",
      err instanceof Error ? err.message : String(err),
    );
  }

  // 3b. Recover webhook events stuck in "processing" — see follow-up to #81.
  // A fresh boot has no in-flight room cycle, so anything in PROCESSING is a
  // zombie from a prior crash that has to be requeued.
  try {
    const resetEvents = await resetStuckProcessingEvents();
    if (resetEvents > 0) {
      console.log(`[Webhooks] Reset ${resetEvents} stale processing event(s) to pending`);
    }
  } catch (err) {
    console.error(
      "[Webhooks] Boot cleanup failed (non-fatal):",
      err instanceof Error ? err.message : String(err),
    );
  }

  // --- Message handlers (sync + streaming) ---

  // 3a. Synchronous message handler
  async function handleMessage(msg: IncomingMessage, abortSignal?: AbortSignal): Promise<OutgoingMessage> {
    const effectiveInstanceId = msg.instanceId || DEFAULT_INSTANCE_ID;

    // Check if this is a reply to an active webhook-triggered conversation.
    // Active triggers take priority over Room interception.
    const activeTrigger = getActiveTrigger(effectiveInstanceId, msg.channelType, msg.channelId);
    if (!activeTrigger) {
      // Check if this message is a human reply to a Room's outbound channel
      const roomCheck = await getCachedRoom(effectiveInstanceId);
      if (
        roomCheck?.enabled &&
        roomCheck.outboundChannel === msg.channelType &&
        roomCheck.outboundTarget === msg.channelId
      ) {
        await roomScheduler.triggerImmediate(roomCheck, effectiveInstanceId, msg.text);
        return { text: "" };
      }
    }

    // Check if this message is a reply to a scheduled task's outbound channel.
    // Resolved internally — never read the override from msg.metadata (untrusted channel data).
    const taskMatch = await getCachedTaskOutbound(
      msg.instanceId || DEFAULT_INSTANCE_ID,
      msg.channelType,
      msg.channelId,
    );
    const taskConversationOverride = taskMatch?.lastConversationId ?? null;

    // Phase 1: Context preparation
    const pre = await runPipelinePre(msg, taskConversationOverride);

    const { ctx, contextPrepMs, messageText } = pre;

    // Phase 3: Supervisor (LLM call + tool building)
    const agentMeta = msg.metadata?.agentCall as AgentCallMetadata | undefined;
    let result;
    try {
      result = await supervise({
        message: messageText,
        conversationHistory: ctx.history,
        instanceId: ctx.instanceId,
        conversationId: ctx.conversationId,
        conversationSummary: ctx.conversationSummary,
        contextPrompt: ctx.contextPrompt,
        channelIdentity: ctx.channelIdentity,
        provider: ctx.instanceConfig.provider,
        model: ctx.instanceConfig.model,
        apiKeys: ctx.instanceConfig.apiKeys,
        secrets: ctx.instanceConfig.secrets,
        langsmith: ctx.langsmith,
        memoryEnabled: ctx.instanceConfig.memoryEnabled,
        knowledgeEnabled: ctx.instanceConfig.knowledgeEnabled,
        thinkingEnabled: ctx.instanceConfig.thinkingEnabled,
        attachments: msg.attachments,
        abortSignal,
        agentCallDepth: agentMeta?.depth,
        agentCallMetadata: agentMeta,
      });
    } catch (err) {
      if (isMissingApiKeyError(err)) {
        pipelineLog.response(ctx.instanceId, Date.now() - ctx.pipelineStart);
        return { text: MISSING_KEY_RESPONSE };
      }
      throw err;
    }

    // Phase 4+5: Trace + afterResponse (skipped on abort)
    const { finalText } = await runPipelinePost({
      ctx,
      contextPrepMs,
      messageText,
      channel: msg.channelType,
      resultText: result.text,
      steps: result.steps,
      reasoning: result.reasoning,
      toolCallTraces: result.toolCallTraces,
      usage: result.usage,
      durationMs: result.durationMs,
      toolBuildingMs: result.toolBuildingMs,
      isStreaming: false,
      abortSignal,
    });

    return {
      text: finalText,
      toolCalls: result.toolCallTraces?.map((t) => ({ name: t.name, durationMs: t.duration_ms })),
      usage: result.usage ? { promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens } : undefined,
    };
  }

  // 3b. Streaming message handler (for OpenAI-compatible SSE)
  async function handleMessageStream(msg: IncomingMessage, abortSignal?: AbortSignal): Promise<StreamOutgoingMessage> {
    // Phase 1: Context preparation
    const pre = await runPipelinePre(msg);

    const { ctx, contextPrepMs, messageText } = pre;

    // Phase 3: Supervisor (LLM streaming + tool building)
    const agentMetaStream = msg.metadata?.agentCall as AgentCallMetadata | undefined;
    let stream;
    try {
      stream = await superviseStream({
        message: messageText,
        conversationHistory: ctx.history,
        instanceId: ctx.instanceId,
        conversationId: ctx.conversationId,
        conversationSummary: ctx.conversationSummary,
        contextPrompt: ctx.contextPrompt,
        channelIdentity: ctx.channelIdentity,
        provider: ctx.instanceConfig.provider,
        model: ctx.instanceConfig.model,
        apiKeys: ctx.instanceConfig.apiKeys,
        secrets: ctx.instanceConfig.secrets,
        langsmith: ctx.langsmith,
        memoryEnabled: ctx.instanceConfig.memoryEnabled,
        knowledgeEnabled: ctx.instanceConfig.knowledgeEnabled,
        thinkingEnabled: ctx.instanceConfig.thinkingEnabled,
        attachments: msg.attachments,
        abortSignal,
        agentCallDepth: agentMetaStream?.depth,
        agentCallMetadata: agentMetaStream,
      });
    } catch (err) {
      if (isMissingApiKeyError(err)) {
        pipelineLog.response(ctx.instanceId, Date.now() - ctx.pipelineStart);
        async function* singleChunk() { yield MISSING_KEY_RESPONSE; }
        return {
          textStream: singleChunk(),
          fullStream: (async function* () { yield { type: "text-delta", textDelta: MISSING_KEY_RESPONSE }; })(),
          completed: Promise.resolve({ text: MISSING_KEY_RESPONSE }),
        };
      }
      throw err;
    }

    // Phase 4+5: Deferred — runs after stream completes (skipped on abort)
    const completed = stream.completed.then(async (result) => {
      const { finalText } = await runPipelinePost({
        ctx,
        contextPrepMs,
        messageText,
        channel: msg.channelType,
        resultText: result.text,
        steps: result.steps,
        reasoning: result.reasoning,
        toolCallTraces: result.toolCallTraces,
        usage: result.usage,
        durationMs: result.durationMs,
        toolBuildingMs: result.toolBuildingMs,
        ttfbMs: result.ttfbMs,
        isStreaming: true,
        abortSignal,
      });

      return { text: finalText };
    });

    return { textStream: stream.textStream, fullStream: stream.fullStream, completed };
  }

  // 4. Start NestJS HTTP server (OpenAI-compatible API)
  const nestApp = await startServer(handleMessage, handleMessageStream);

  // 5. Start per-instance channel adapters from DB
  channelManager.setMessageHandler(handleMessage);

  const allInstances = await listAllInstances();
  for (const inst of allInstances) {
    if (inst.status === "active") {
      channelManager.startAllForInstance(inst.slug).catch((err) => {
        console.error(`Failed to start channels for instance "${inst.slug}" — skipping:`, err);
      });
    }
  }

  // 6. Start scheduled task scheduler
  schedulerService.initialize(handleMessage);
  await schedulerService.start();

  // 7. Start room scheduler
  roomScheduler.start();

  const activeChannels = channelManager.getActiveChannels();

  // Build the boot summary. Keep it compact (5-7 lines) and STRIP any password
  // from the connection string before printing — config.postgres.databaseUrl
  // is the raw form `postgresql://user:password@host:port/db`.
  const dbTarget = formatDbTarget(config.postgres.databaseUrl);
  const allTools = Array.from(getToolRegistry().values());
  const harnessTools = allTools.filter((t) => t.harness).length;

  console.log("\nPolyant ready!");
  console.log(`Database:       ${dbTarget}`);
  console.log(`pgvector:       ${pgvectorStatus}`);
  console.log(`Tools registered: ${allTools.length} (${harnessTools} harness)`);
  console.log(`Active channels: ${activeChannels.length > 0 ? activeChannels.map((c) => `${c.instanceSlug}:${c.channelType}`).join(", ") : "none"}`);
  console.log(`HTTP API:       http://localhost:${config.server.port}/v1`);
  console.log(`Admin panel:    open the web package separately (default :3000)`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    await nestApp.close();
    schedulerService.shutdown();
    roomScheduler.shutdown();
    await channelManager.shutdownAll();
    await traceStore.shutdown();
    await auditStore.shutdown();
    await shutdownGateway();
    shutdownFileLogger();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Prevent unhandled rejections from crashing the process (e.g. async adapter failures)
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection (non-fatal):", reason);
});

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
