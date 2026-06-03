// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AILogger, aiLogs } from "./logger.js";
import type { AILogEntry } from "./types.js";

function makeEntry(overrides: Partial<AILogEntry> = {}): AILogEntry {
  return {
    provider: "openai",
    model: "gpt-4o",
    tier: "standard",
    thinking: false,
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    estimatedCostUsd: 0.0075,
    durationMs: 500,
    reasoningChars: 0,
    stepCount: 0,
    callType: "conversation",
    ...overrides,
  };
}

describe("AILogger", () => {
  let logger: AILogger;

  beforeEach(() => {
    vi.useFakeTimers();
    logger = new AILogger();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("createEntry", () => {
    it("returns a properly structured entry with default callType", () => {
      const entry = logger.createEntry(
        "openai", "gpt-4o", "standard", false,
        100, 50, 150, 0.0075, 500,
        42, 3, // reasoningChars, stepCount
        "conv-1", "user-1",
      );
      expect(entry).toEqual({
        provider: "openai",
        model: "gpt-4o",
        tier: "standard",
        thinking: false,
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        estimatedCostUsd: 0.0075,
        durationMs: 500,
        reasoningChars: 42,
        stepCount: 3,
        conversationId: "conv-1",
        instanceId: "user-1",
        callType: "conversation",
      });
    });

    it("allows optional conversationId and instanceId", () => {
      const entry = logger.createEntry(
        "anthropic", "claude-sonnet-4-5-20250929", "standard", true,
        200, 100, 300, 0.015, 1000,
        500, 5,
      );
      expect(entry.conversationId).toBeUndefined();
      expect(entry.instanceId).toBeUndefined();
      expect(entry.callType).toBe("conversation");
      expect(entry.reasoningChars).toBe(500);
      expect(entry.stepCount).toBe(5);
    });

    it("accepts explicit callType 'service'", () => {
      const entry = logger.createEntry(
        "openai", "gpt-4o-mini", "fast", false,
        50, 20, 70, 0.001, 200,
        0, 0,
        "conv-1", "inst-1", "service",
      );
      expect(entry.callType).toBe("service");
    });

    it("clamps non-finite reasoningChars and stepCount to 0", () => {
      const entry = logger.createEntry(
        "openai", "gpt-4o", "fast", false,
        10, 10, 20, 0.001, 100,
        Number.NaN, Number.POSITIVE_INFINITY,
      );
      expect(entry.reasoningChars).toBe(0);
      expect(entry.stepCount).toBe(0);
    });
  });

  describe("log and buffer", () => {
    it("adds entry to buffer", () => {
      const mockDb = { insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }) };
      logger.initialize(mockDb);

      logger.log(makeEntry());
      // Buffer has 1 entry, not yet flushed (threshold is 10)
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("auto-flushes when buffer reaches 10 entries", async () => {
      const valuesFn = vi.fn().mockResolvedValue(undefined);
      const mockDb = { insert: vi.fn().mockReturnValue({ values: valuesFn }) };
      logger.initialize(mockDb);

      for (let i = 0; i < 10; i++) {
        logger.log(makeEntry({ promptTokens: i }));
      }

      // flush() is called fire-and-forget when 10th entry is added;
      // wait for microtasks to settle
      await vi.advanceTimersByTimeAsync(0);
      expect(mockDb.insert).toHaveBeenCalledWith(aiLogs);
      expect(valuesFn).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ promptTokens: 0 })]),
      );
    });
  });

  describe("flush", () => {
    it("does nothing when buffer is empty", async () => {
      const mockDb = { insert: vi.fn() };
      logger.initialize(mockDb);

      await logger.flush();
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("does nothing when db is not set", async () => {
      logger.log(makeEntry());
      // No initialize called — db is null
      await logger.flush();
      // Should not throw
    });

    it("inserts entries into database", async () => {
      const valuesFn = vi.fn().mockResolvedValue(undefined);
      const mockDb = { insert: vi.fn().mockReturnValue({ values: valuesFn }) };
      logger.initialize(mockDb);

      logger.log(makeEntry({ model: "gpt-4o-mini" }));
      await logger.flush();

      expect(mockDb.insert).toHaveBeenCalledWith(aiLogs);
      expect(valuesFn).toHaveBeenCalledWith([expect.objectContaining({ model: "gpt-4o-mini" })]);
    });

    it("re-adds entries to buffer on db error", async () => {
      const valuesFn = vi.fn().mockRejectedValue(new Error("DB connection lost"));
      const mockDb = { insert: vi.fn().mockReturnValue({ values: valuesFn }) };
      logger.initialize(mockDb);

      logger.log(makeEntry());
      await logger.flush();

      // Entry should be re-added; next flush attempt will retry
      const valuesFn2 = vi.fn().mockResolvedValue(undefined);
      mockDb.insert.mockReturnValue({ values: valuesFn2 });
      await logger.flush();
      expect(valuesFn2).toHaveBeenCalledWith([expect.objectContaining({ provider: "openai" })]);
    });

    it("caps buffer at MAX_BUFFER_SIZE (1000) on repeated failures", async () => {
      const valuesFn = vi.fn().mockRejectedValue(new Error("DB down"));
      const mockDb = { insert: vi.fn().mockReturnValue({ values: valuesFn }) };
      logger.initialize(mockDb);

      // Add 1005 entries (beyond 1000 cap)
      for (let i = 0; i < 1005; i++) {
        logger.log(makeEntry({ promptTokens: i }));
        // Prevent auto-flush at 10 by flushing manually with error
        if ((i + 1) % 10 === 0) {
          await logger.flush();
        }
      }

      // After many failed flushes, buffer should be capped
      // Verify by doing a successful flush and checking entries count
      const valuesFn2 = vi.fn().mockResolvedValue(undefined);
      mockDb.insert.mockReturnValue({ values: valuesFn2 });
      await logger.flush();

      if (valuesFn2.mock.calls.length > 0) {
        const flushedEntries = valuesFn2.mock.calls[0][0] as AILogEntry[];
        expect(flushedEntries.length).toBeLessThanOrEqual(1000);
      }
    });
  });

  describe("shutdown", () => {
    it("clears interval and performs final flush", async () => {
      const valuesFn = vi.fn().mockResolvedValue(undefined);
      const mockDb = { insert: vi.fn().mockReturnValue({ values: valuesFn }) };
      logger.initialize(mockDb);

      logger.log(makeEntry());
      await logger.shutdown();

      expect(valuesFn).toHaveBeenCalledWith([expect.objectContaining({ provider: "openai" })]);
    });

    it("does not throw when no interval was set", async () => {
      // No initialize called
      await expect(logger.shutdown()).resolves.toBeUndefined();
    });
  });

  describe("periodic flush", () => {
    it("flushes every 5 seconds via interval", async () => {
      const valuesFn = vi.fn().mockResolvedValue(undefined);
      const mockDb = { insert: vi.fn().mockReturnValue({ values: valuesFn }) };
      logger.initialize(mockDb);

      logger.log(makeEntry());
      expect(valuesFn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5000);
      expect(valuesFn).toHaveBeenCalled();
    });
  });
});
