// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockAudit } from "../../test-utils.js";

const mockUpsert = vi.fn();
const mockAppend = vi.fn();
const mockProcessDocument = vi.fn();

vi.mock("../../knowledge/store.js", async () => {
  const actual = await vi.importActual<typeof import("../../knowledge/store.js")>(
    "../../knowledge/store.js",
  );
  return {
    ...actual,
    upsertAgentDocument: (...args: unknown[]) => mockUpsert(...args),
    appendAgentDocument: (...args: unknown[]) => mockAppend(...args),
  };
});

vi.mock("../../knowledge/ingestion.js", () => ({
  processDocument: (...args: unknown[]) => mockProcessDocument(...args),
}));

import "./write-knowledge.tool.js";
import { getToolRegistry, buildTool } from "./registry.js";
import { DocumentSizeExceededError } from "../../knowledge/store.js";

const ctx = {
  instanceId: "inst-1",
  secrets: { openai_api_key: "sk-test" },
  audit: createMockAudit(),
} as any;

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("writeKnowledge tool", () => {
  const def = getToolRegistry().get("writeKnowledge")!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const writeKnowledge = buildTool(def, ctx) as any;

  beforeEach(async () => {
    // Flush any setImmediate scheduled by a previous test before clearing mocks,
    // otherwise late reindex calls leak into the new test's counters.
    await flushMicrotasks();
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockProcessDocument.mockResolvedValue({ chunkCount: 1 });
  });

  it("registers with correct metadata", () => {
    expect(def.name).toBe("writeKnowledge");
    expect(def.category).toBe("knowledge");
    expect(writeKnowledge.inputSchema).toBeDefined();
  });

  it("calls upsertAgentDocument for action='write' and schedules reindex", async () => {
    mockUpsert.mockResolvedValue({
      docId: "doc-1",
      created: true,
      sizeBytes: 5,
      rawContent: "hello",
    });

    const result = await writeKnowledge.execute(
      { action: "write", filename: "a.md", content: "hello", mimeType: null },
      { toolCallId: "tc-1", messages: [] } as any,
    );

    expect(mockUpsert).toHaveBeenCalledWith({
      instanceId: "inst-1",
      filename: "a.md",
      content: "hello",
      mimeType: undefined,
    });
    expect(result).toEqual({
      ok: true,
      filename: "a.md",
      docId: "doc-1",
      created: true,
      reindexScheduled: true,
      sizeBytes: 5,
    });

    await flushMicrotasks();
    expect(mockProcessDocument).toHaveBeenCalledWith("doc-1", "inst-1", "hello");
  });

  it("calls appendAgentDocument for action='append'", async () => {
    mockAppend.mockResolvedValue({
      docId: "doc-2",
      created: false,
      sizeBytes: 12,
      rawContent: "foo\n\nbar",
    });

    const result = await writeKnowledge.execute(
      { action: "append", filename: "log.md", content: "bar", mimeType: null },
      { toolCallId: "tc-1", messages: [] } as any,
    );

    expect(mockAppend).toHaveBeenCalledWith({
      instanceId: "inst-1",
      filename: "log.md",
      content: "bar",
      mimeType: undefined,
    });
    expect(result.ok).toBe(true);
    expect(result.created).toBe(false);
    expect(result.sizeBytes).toBe(12);

    await flushMicrotasks();
    expect(mockProcessDocument).toHaveBeenCalledWith("doc-2", "inst-1", "foo\n\nbar");
  });

  it("forwards custom mimeType on creation", async () => {
    mockUpsert.mockResolvedValue({
      docId: "doc-3",
      created: true,
      sizeBytes: 3,
      rawContent: "raw",
    });

    await writeKnowledge.execute(
      { action: "write", filename: "data.json", content: "raw", mimeType: "application/json" },
      { toolCallId: "tc-1", messages: [] } as any,
    );

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: "application/json" }),
    );
  });

  it("returns size-exceeded error without scheduling reindex", async () => {
    mockUpsert.mockRejectedValue(
      new DocumentSizeExceededError("Input content exceeds 1048576 bytes (got 2000000)."),
    );

    const result = await writeKnowledge.execute(
      { action: "write", filename: "big.md", content: "x".repeat(10), mimeType: null },
      { toolCallId: "tc-1", messages: [] } as any,
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe("DOCUMENT_SIZE_EXCEEDED");

    await flushMicrotasks();
    expect(mockProcessDocument).not.toHaveBeenCalled();
  });

  it("returns generic error when the store call fails", async () => {
    mockAppend.mockRejectedValue(new Error("DB down"));

    const result = await writeKnowledge.execute(
      { action: "append", filename: "x.md", content: "y", mimeType: null },
      { toolCallId: "tc-1", messages: [] } as any,
    );

    expect(result).toEqual({ ok: false, error: "DB down" });

    await flushMicrotasks();
    expect(mockProcessDocument).not.toHaveBeenCalled();
  });
});
