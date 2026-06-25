// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pipelineLog } from "./pipeline-logger.js";

describe("pipelineLog", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  /** Join all console.log calls into a single string for easy assertion */
  function allOutput(): string {
    return consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
  }

  describe("request", () => {
    it("returns a requestId string", () => {
      const id = pipelineLog.request("telegram", "user-1", "Hello");
      expect(typeof id).toBe("string");
      expect(id.length).toBe(8);
    });

    it("logs request info to console", () => {
      pipelineLog.request("telegram", "user-1", "Hello");
      expect(consoleSpy).toHaveBeenCalled();
      expect(allOutput()).toContain("PIPELINE");
      expect(allOutput()).toContain("REQUEST");
    });

    it("truncates long messages", () => {
      const longMsg = "A".repeat(200);
      pipelineLog.request("telegram", "user-1", longMsg);
      expect(allOutput()).toContain("...");
    });
  });

  describe("llmCall", () => {
    it("logs tier and model info", () => {
      pipelineLog.llmCall("my-instance", "standard", "gpt-4o", true);
      expect(consoleSpy).toHaveBeenCalled();
      expect(allOutput()).toContain("LLM CALL");
      expect(allOutput()).toContain("standard");
      expect(allOutput()).toContain("gpt-4o");
    });
  });

  describe("llmResponse", () => {
    it("logs model, tokens, and duration", () => {
      pipelineLog.llmResponse("my-instance", "gpt-4o", { prompt: 100, completion: 50 }, 500, 2);
      expect(allOutput()).toContain("LLM DONE");
      expect(allOutput()).toContain("100+50");
      expect(allOutput()).toContain("500ms");
    });
  });

  describe("toolCall", () => {
    it("logs tool name and formatted args", () => {
      pipelineLog.toolCall("my-instance", "searchMemory", { query: "test query", limit: 10 });
      expect(allOutput()).toContain("TOOL");
      expect(allOutput()).toContain("searchMemory");
      expect(allOutput()).toContain("query=test query");
    });

    it("truncates long string args", () => {
      pipelineLog.toolCall("my-instance", "searchMemory", { query: "A".repeat(100) });
      expect(allOutput()).toContain("...");
    });
  });

  describe("toolResult", () => {
    it("logs success result", () => {
      pipelineLog.toolResult("my-instance", "searchMemory", true, "Found 5 results");
      expect(allOutput()).toContain("searchMemory");
    });

    it("logs failure result", () => {
      pipelineLog.toolResult("my-instance", "searchMemory", false, "Error occurred");
      expect(allOutput()).toContain("searchMemory");
    });
  });

  describe("supervisorStart", () => {
    it("logs tool count", () => {
      pipelineLog.supervisorStart("my-instance", 5);
      expect(allOutput()).toContain("SUPERVISOR");
      expect(allOutput()).toContain("5");
    });
  });

  describe("supervisorDone", () => {
    it("logs duration and truncated response preview", () => {
      pipelineLog.supervisorDone("my-instance", 1200, "This is the response text");
      expect(allOutput()).toContain("SUPERVISOR DONE");
      expect(allOutput()).toContain("1200ms");
    });
  });

  describe("preEnrichment", () => {
    it("logs summary availability", () => {
      pipelineLog.preEnrichment("my-instance", true);
      expect(allOutput()).toContain("CONTEXT");
      expect(allOutput()).toContain("yes");
    });

    it("logs no summary", () => {
      pipelineLog.preEnrichment("my-instance", false);
      expect(allOutput()).toContain("no");
    });
  });

  describe("response", () => {
    it("logs total duration", () => {
      pipelineLog.response("my-instance", 2500);
      expect(allOutput()).toContain("RESPONSE");
      expect(allOutput()).toContain("2500ms");
    });
  });

  describe("systemPrompt", () => {
    it("logs the prompt length", () => {
      pipelineLog.systemPrompt("my-instance", "A".repeat(123));
      expect(allOutput()).toContain("SYSTEM PROMPT");
      expect(allOutput()).toContain("length=123 chars");
    });

    it("never logs the full prompt body", () => {
      const body = "TOP-SECRET-PROMPT-BODY-" + "X".repeat(500);
      pipelineLog.systemPrompt("my-instance", body);
      expect(allOutput()).not.toContain("TOP-SECRET-PROMPT-BODY");
    });
  });

  describe("agentId propagation", () => {
    it("includes agentId in llmCall", () => {
      pipelineLog.llmCall("my-instance", "standard", "gpt-4o", true);
      expect(allOutput()).toContain("[my-instance]");
    });

    it("includes agentId in llmResponse", () => {
      pipelineLog.llmResponse("my-instance", "gpt-4o", { prompt: 100, completion: 50 }, 500, 0);
      expect(allOutput()).toContain("[my-instance]");
    });

    it("includes agentId in toolCall", () => {
      pipelineLog.toolCall("my-instance", "searchMemory", { query: "test" });
      expect(allOutput()).toContain("[my-instance]");
    });

    it("includes agentId in supervisorStart", () => {
      pipelineLog.supervisorStart("my-instance", 5);
      expect(allOutput()).toContain("[my-instance]");
    });

    it("includes agentId in preEnrichment", () => {
      pipelineLog.preEnrichment("my-instance", true);
      expect(allOutput()).toContain("[my-instance]");
    });

    it("includes agentId in response()", () => {
      pipelineLog.response("my-instance", 1000);
      expect(allOutput()).toContain("[my-instance]");
    });

    it("does not include agentId when empty string is passed", () => {
      pipelineLog.llmCall("", "standard", "gpt-4o", true);
      expect(allOutput()).not.toContain("[]");
    });
  });
});
