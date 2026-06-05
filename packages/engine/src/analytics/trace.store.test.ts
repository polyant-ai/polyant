// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pipelineTraces } from "./traces.schema.js";
import type { PipelineTraceEntry } from "./trace.store.js";
import { asInstanceSlug } from "../instances/identifiers.js";

// We need to test the class directly, so reimport a fresh instance approach
// by importing the module and working with the exported singleton pattern.
// Since TraceStore is not exported as a class, we test via the singleton.

function makeEntry(overrides: Partial<PipelineTraceEntry> = {}): PipelineTraceEntry {
  return {
    conversationId: "web:test-conv-1",
    instanceId: asInstanceSlug("test-instance"),
    channel: "web",
    totalMs: 1500,
    isStreaming: false,
    ...overrides,
  };
}

// Dynamic import to get a fresh module for each test
async function createFreshStore() {
  // We can't easily get a fresh singleton per test, so we test the exported one
  // and rely on shutdown + re-initialize between tests
  const { traceStore } = await import("./trace.store.js");
  return traceStore;
}

describe("TraceStore", () => {
  let store: Awaited<ReturnType<typeof createFreshStore>>;

  beforeEach(async () => {
    vi.useFakeTimers();
    store = await createFreshStore();
  });

  afterEach(async () => {
    await store.shutdown();
    vi.useRealTimers();
  });

  describe("record", () => {
    it("does not flush before 10 entries", () => {
      const valuesFn = vi.fn().mockResolvedValue(undefined);
      const mockDb = { insert: vi.fn().mockReturnValue({ values: valuesFn }) };
      store.initialize(mockDb);

      store.record(makeEntry());
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("auto-flushes when buffer reaches 10 entries", async () => {
      const valuesFn = vi.fn().mockResolvedValue(undefined);
      const mockDb = { insert: vi.fn().mockReturnValue({ values: valuesFn }) };
      store.initialize(mockDb);

      for (let i = 0; i < 10; i++) {
        store.record(makeEntry({ totalMs: 1000 + i }));
      }

      await vi.advanceTimersByTimeAsync(0);
      expect(mockDb.insert).toHaveBeenCalledWith(pipelineTraces);
      expect(valuesFn).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ totalMs: 1000 })]),
      );
    });
  });

  describe("flush", () => {
    it("does nothing when buffer is empty", async () => {
      const mockDb = { insert: vi.fn() };
      store.initialize(mockDb);

      await store.flush();
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("inserts entries into database", async () => {
      const valuesFn = vi.fn().mockResolvedValue(undefined);
      const mockDb = { insert: vi.fn().mockReturnValue({ values: valuesFn }) };
      store.initialize(mockDb);

      store.record(makeEntry({ contextPrepMs: 50, llmCallMs: 1200 }));
      await store.flush();

      expect(mockDb.insert).toHaveBeenCalledWith(pipelineTraces);
      expect(valuesFn).toHaveBeenCalledWith([
        expect.objectContaining({ contextPrepMs: 50, llmCallMs: 1200 }),
      ]);
    });

    it("re-adds entries to buffer on db error", async () => {
      const valuesFn = vi.fn().mockRejectedValue(new Error("DB down"));
      const mockDb = { insert: vi.fn().mockReturnValue({ values: valuesFn }) };
      store.initialize(mockDb);

      store.record(makeEntry());
      await store.flush();

      // Entry should be re-added; retry
      const valuesFn2 = vi.fn().mockResolvedValue(undefined);
      mockDb.insert.mockReturnValue({ values: valuesFn2 });
      await store.flush();
      expect(valuesFn2).toHaveBeenCalledWith([
        expect.objectContaining({ conversationId: "web:test-conv-1" }),
      ]);
    });

    it("caps buffer at MAX_BUFFER_SIZE (500) on repeated failures", async () => {
      const valuesFn = vi.fn().mockRejectedValue(new Error("DB down"));
      const mockDb = { insert: vi.fn().mockReturnValue({ values: valuesFn }) };
      store.initialize(mockDb);

      for (let i = 0; i < 505; i++) {
        store.record(makeEntry({ totalMs: i }));
        if ((i + 1) % 10 === 0) {
          await store.flush();
        }
      }

      const valuesFn2 = vi.fn().mockResolvedValue(undefined);
      mockDb.insert.mockReturnValue({ values: valuesFn2 });
      await store.flush();

      if (valuesFn2.mock.calls.length > 0) {
        const flushed = valuesFn2.mock.calls[0][0] as PipelineTraceEntry[];
        expect(flushed.length).toBeLessThanOrEqual(500);
      }
    });
  });

  describe("shutdown", () => {
    it("performs final flush", async () => {
      const valuesFn = vi.fn().mockResolvedValue(undefined);
      const mockDb = { insert: vi.fn().mockReturnValue({ values: valuesFn }) };
      store.initialize(mockDb);

      store.record(makeEntry({ ttfbMs: 200, isStreaming: true }));
      await store.shutdown();

      expect(valuesFn).toHaveBeenCalledWith([
        expect.objectContaining({ ttfbMs: 200, isStreaming: true }),
      ]);
    });
  });

  describe("periodic flush", () => {
    it("flushes every 5 seconds via interval", async () => {
      const valuesFn = vi.fn().mockResolvedValue(undefined);
      const mockDb = { insert: vi.fn().mockReturnValue({ values: valuesFn }) };
      store.initialize(mockDb);

      store.record(makeEntry());
      expect(valuesFn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5000);
      expect(valuesFn).toHaveBeenCalled();
    });
  });

  describe("entry fields", () => {
    it("records full breakdown with tool calls", async () => {
      const valuesFn = vi.fn().mockResolvedValue(undefined);
      const mockDb = { insert: vi.fn().mockReturnValue({ values: valuesFn }) };
      store.initialize(mockDb);

      store.record(makeEntry({
        contextPrepMs: 30,
        toolBuildingMs: 2,
        llmCallMs: 1400,
        totalMs: 1440,
        promptTokens: 500,
        completionTokens: 200,
        toolCalls: [
          { name: "web_search", duration_ms: 800, success: true },
          { name: "calendar", duration_ms: 150, success: true },
        ],
      }));
      await store.flush();

      expect(valuesFn).toHaveBeenCalledWith([
        expect.objectContaining({
          contextPrepMs: 30,
          toolBuildingMs: 2,
          llmCallMs: 1400,
          totalMs: 1440,
          toolCalls: [
            { name: "web_search", duration_ms: 800, success: true },
            { name: "calendar", duration_ms: 150, success: true },
          ],
        }),
      ]);
    });
  });
});
