// SPDX-License-Identifier: AGPL-3.0-or-later

import { pipelineTraces, type ToolCallTrace } from "./traces.schema.js";
import { type InstanceSlug } from "../instances/identifiers.js";
import type { CostBreakdown } from "../ai-gateway/types.js";
import { BufferedInsertQueue, type InsertableDb } from "../utils/buffered-insert-queue.js";

export interface PipelineTraceEntry {
  conversationId: string;
  /** Assistant message this turn produced — the robust link for per-message metadata. */
  messageId?: string;
  instanceId: InstanceSlug;
  channel: string;
  contextPrepMs?: number;
  toolBuildingMs?: number;
  llmCallMs?: number;
  totalMs: number;
  ttfbMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** The 5-minute-TTL share of `cacheCreationInputTokens`; absent when the provider reports no TTL split. */
  cacheCreation5mInputTokens?: number;
  /** Model id actually used for this turn. */
  model?: string;
  /** Provider that served the model. */
  provider?: string;
  /** USD cost split for this turn. */
  cost?: CostBreakdown;
  /** Whether extended thinking was requested for this turn. */
  thinking?: boolean;
  /** Sampling temperature requested (undefined → provider default). */
  temperature?: number;
  toolCalls?: ToolCallTrace[];
  isStreaming: boolean;
  /** STT provider name (e.g. "openai", "deepgram", "aws"). Null for non-audio turns. */
  sttProvider?: string | null;
  /** Audio duration reported by the STT provider, in seconds. Null for non-audio turns. */
  audioDurationSec?: string | null;
  /** Wall-clock time taken by the STT transcription phase, in ms. Null for non-audio turns. */
  sttDurationMs?: number | null;
  /** For agent-to-agent calls: the conversation ID of the calling agent. */
  parentConversationId?: string;
  /** For agent-to-agent calls: the trace ID of the calling agent's pipeline run. */
  parentTraceId?: string;
}

class TraceStore {
  private readonly queue = new BufferedInsertQueue<PipelineTraceEntry>({
    table: pipelineTraces,
    label: "pipeline traces",
  });

  initialize(db: InsertableDb) {
    this.queue.initialize(db);
  }

  record(entry: PipelineTraceEntry) {
    this.queue.push(entry);
  }

  flush() {
    return this.queue.flush();
  }

  shutdown() {
    return this.queue.shutdown();
  }
}

export const traceStore = new TraceStore();
