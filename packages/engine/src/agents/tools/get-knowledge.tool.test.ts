// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockAudit } from "../../test-utils.js";

const mockGetDocumentByFilename = vi.fn();

vi.mock("../../knowledge/store.js", () => ({
  getDocumentByFilename: (...args: unknown[]) => mockGetDocumentByFilename(...args),
}));

import getKnowledgeTool from "./get-knowledge.tool.js";
import { buildTool } from "./registry.js";

const ctx = {
  instanceId: "inst-1",
  audit: createMockAudit(),
} as any;

describe("getKnowledge tool", () => {
  const def = getKnowledgeTool;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getKnowledge = buildTool(def, ctx) as any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("registers with correct metadata", () => {
    expect(def.name).toBe("getKnowledge");
    expect(def.category).toBe("knowledge");
    expect(getKnowledge.description).toBeDefined();
    expect(getKnowledge.inputSchema).toBeDefined();
  });

  it("returns found=false when the document does not exist", async () => {
    mockGetDocumentByFilename.mockResolvedValue(undefined);

    const result = await getKnowledge.execute(
      { filename: "missing.md", offset: null },
      { toolCallId: "tc-1", messages: [] } as any,
    );

    expect(mockGetDocumentByFilename).toHaveBeenCalledWith("inst-1", "missing.md");
    expect(result).toEqual({ found: false });
  });

  it("returns the full document on hit", async () => {
    const updatedAt = new Date("2026-04-17T10:00:00Z");
    mockGetDocumentByFilename.mockResolvedValue({
      id: "doc-1",
      instanceId: "inst-1",
      filename: "policy.md",
      mimeType: "text/markdown",
      sizeBytes: 42,
      rawContent: "# Policy\n\nBody",
      contentHash: "abc",
      source: "agent",
      status: "ready",
      chunkCount: 1,
      errorMessage: null,
      enabled: true,
      createdAt: new Date("2026-04-16T10:00:00Z"),
      updatedAt,
    });

    const result = await getKnowledge.execute(
      { filename: "policy.md", offset: null },
      { toolCallId: "tc-1", messages: [] } as any,
    );

    expect(result).toEqual({
      found: true,
      filename: "policy.md",
      content: "# Policy\n\nBody",
      truncated: false,
      totalChars: 14,
      mimeType: "text/markdown",
      sizeBytes: 42,
      source: "agent",
      status: "ready",
      updatedAt: updatedAt.toISOString(),
    });
  });

  // A document can be megabytes of text; returned whole it outgrows the
  // model's context, and a replayed tool result carries it into later turns.
  describe("a document longer than one result", () => {
    const rawContent = Array.from({ length: 12_000 }, (_, i) => `line ${String(i).padStart(4, "0")}`).join("\n");
    const doc = {
      id: "doc-3",
      instanceId: "inst-1",
      filename: "manual.txt",
      mimeType: "text/plain",
      sizeBytes: rawContent.length,
      rawContent,
      contentHash: "ghi",
      source: "upload",
      status: "ready",
      chunkCount: 60,
      errorMessage: null,
      enabled: true,
      createdAt: null,
      updatedAt: null,
    };
    const read = (offset: number | null) =>
      getKnowledge.execute({ filename: "manual.txt", offset }, { toolCallId: "tc-1", messages: [] } as any);

    it("returns the first 50,000 characters and where to continue", async () => {
      mockGetDocumentByFilename.mockResolvedValue(doc);

      const result = await read(null);

      expect(result.content).toBe(rawContent.slice(0, 50_000));
      expect(result).toMatchObject({ truncated: true, nextOffset: 50_000, totalChars: rawContent.length });
    });

    it("hands back the whole document across pages", async () => {
      mockGetDocumentByFilename.mockResolvedValue(doc);

      let text = "";
      let offset: number | null = null;
      for (let page = 0; page < 10; page++) {
        const result = await read(offset);
        text += result.content;
        if (!result.truncated) break;
        offset = result.nextOffset;
      }

      expect(text).toBe(rawContent);
    });
  });

  it("returns found=false for a switched-off document", async () => {
    mockGetDocumentByFilename.mockResolvedValue({
      id: "doc-2",
      instanceId: "inst-1",
      filename: "old-policy.md",
      mimeType: "text/markdown",
      sizeBytes: 12,
      rawContent: "stale",
      contentHash: "def",
      source: "upload",
      status: "ready",
      chunkCount: 1,
      errorMessage: null,
      enabled: false,
      createdAt: new Date("2026-04-16T10:00:00Z"),
      updatedAt: new Date("2026-04-17T10:00:00Z"),
    });

    const result = await getKnowledge.execute(
      { filename: "old-policy.md" },
      { toolCallId: "tc-1", messages: [] } as any,
    );

    expect(result).toEqual({ found: false });
  });

  it("returns found=false with error when store throws", async () => {
    mockGetDocumentByFilename.mockRejectedValue(new Error("DB unreachable"));

    const result = await getKnowledge.execute(
      { filename: "any.md" },
      { toolCallId: "tc-1", messages: [] } as any,
    );

    expect(result).toEqual({ found: false, error: "DB unreachable" });
  });
});
