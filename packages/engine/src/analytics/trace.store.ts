// SPDX-License-Identifier: AGPL-3.0-or-later

import { pipelineTraces, type ToolCallTrace } from "./traces.schema.js";
import { type InstanceSlug } from "../instances/identifiers.js";

export interface PipelineTraceEntry {
  conversationId: string;
  instanceId: InstanceSlug;
  channel: string;
  contextPrepMs?: number;
  toolBuildingMs?: number;
  llmCallMs?: number;
  totalMs: number;
  ttfbMs?: number;
  promptTokens?: number;
  completionTokens?: number;
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

/** Minimal DB interface for insert operations. */
interface InsertableDb {
  insert(table: unknown): { values(v: unknown): Promise<unknown> };
}

class TraceStore {
  private static readonly MAX_BUFFER_SIZE = 500;
  private buffer: PipelineTraceEntry[] = [];
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private db: InsertableDb | null = null;
  private flushing = false;
  private flushSkipped = 0;

  initialize(db: InsertableDb) {
    this.db = db;
    this.flushInterval = setInterval(() => this.flush(), 5000);
  }

  record(entry: PipelineTraceEntry) {
    this.buffer.push(entry);
    if (this.buffer.length >= 10) {
      this.flush();
    }
  }

  async flush() {
    // Guard against concurrent flushes: two overlapping flush() calls could snapshot
    // the same entries, leading to DB duplicates on success or ordering corruption on failure.
    if (this.flushing || this.buffer.length === 0 || !this.db) {
      if (this.flushing && this.buffer.length > 0) {
        // Don't log every skip — one in twenty is enough to spot capacity pressure.
        this.flushSkipped += 1;
        if (this.flushSkipped % 20 === 0) {
          console.debug(
            `TraceStore: flush skipped ${this.flushSkipped}× (buffer=${this.buffer.length}, another flush in progress)`,
          );
        }
      }
      return;
    }
    this.flushing = true;

    const entries = [...this.buffer];
    this.buffer = [];

    try {
      await this.db.insert(pipelineTraces).values(entries);
    } catch (err) {
      console.error("Failed to flush pipeline traces:", err);
      // Prepend failed entries so ordering is preserved: oldest first, then newer entries
      // appended since the flush started.
      this.buffer = [...entries, ...this.buffer];
      if (this.buffer.length > TraceStore.MAX_BUFFER_SIZE) {
        const dropped = this.buffer.length - TraceStore.MAX_BUFFER_SIZE;
        this.buffer = this.buffer.slice(-TraceStore.MAX_BUFFER_SIZE);
        console.warn(`TraceStore: dropped ${dropped} oldest trace entries, keeping newest (buffer full)`);
      }
    } finally {
      this.flushing = false;
    }
  }

  async shutdown() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }
    await this.flush();
  }
}

export const traceStore = new TraceStore();
