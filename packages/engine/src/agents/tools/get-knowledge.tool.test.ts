// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockAudit } from "../../test-utils.js";

const mockGetDocumentByFilename = vi.fn();

vi.mock("../../knowledge/store.js", () => ({
  getDocumentByFilename: (...args: unknown[]) => mockGetDocumentByFilename(...args),
}));

import "./get-knowledge.tool.js";
import { getToolRegistry, buildTool } from "./registry.js";

const ctx = {
  instanceId: "inst-1",
  audit: createMockAudit(),
} as any;

describe("getKnowledge tool", () => {
  const def = getToolRegistry().get("getKnowledge")!;
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
      { filename: "missing.md" },
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
      createdAt: new Date("2026-04-16T10:00:00Z"),
      updatedAt,
    });

    const result = await getKnowledge.execute(
      { filename: "policy.md" },
      { toolCallId: "tc-1", messages: [] } as any,
    );

    expect(result).toEqual({
      found: true,
      filename: "policy.md",
      content: "# Policy\n\nBody",
      mimeType: "text/markdown",
      sizeBytes: 42,
      source: "agent",
      status: "ready",
      updatedAt: updatedAt.toISOString(),
    });
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
