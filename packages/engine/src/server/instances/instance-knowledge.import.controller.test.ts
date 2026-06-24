// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { BadRequestException } from "@nestjs/common";

// ---------------------------------------------------------------------------
// Mocks for the controller's I/O dependencies. resolveUniqueFilename is given a
// faithful inline copy of the real algorithm (also tested directly in
// knowledge/store.test.ts) so collision-renaming assertions are meaningful
// without pulling the DB client into this unit test.
// ---------------------------------------------------------------------------
const {
  mockFindInstanceOrFail,
  mockCreateDocument,
  mockListDocumentFilenames,
  mockGetKnowledgeForExport,
  mockProcessDocument,
  mockResolveEmbeddingContext,
} = vi.hoisted(() => ({
  mockFindInstanceOrFail: vi.fn(),
  mockCreateDocument: vi.fn(),
  mockListDocumentFilenames: vi.fn(),
  mockGetKnowledgeForExport: vi.fn(),
  mockProcessDocument: vi.fn(),
  mockResolveEmbeddingContext: vi.fn(),
}));

vi.mock("./instance-helpers.js", () => ({ findInstanceOrFail: mockFindInstanceOrFail }));
vi.mock("../../knowledge/ingestion.js", () => ({ processDocument: mockProcessDocument }));
vi.mock("../../embeddings-gateway/index.js", () => ({ resolveEmbeddingContext: mockResolveEmbeddingContext }));
vi.mock("../../config.js", () => ({ config: { knowledge: { maxDocsPerInstance: 3 } } }));
vi.mock("../../knowledge/index.js", () => ({
  createDocument: mockCreateDocument,
  listDocuments: vi.fn(),
  getDocument: vi.fn(),
  deleteDocument: vi.fn(),
  countDocuments: vi.fn(),
  hashContent: () => "hash",
  getKnowledgeForExport: mockGetKnowledgeForExport,
  listDocumentFilenames: mockListDocumentFilenames,
  resolveUniqueFilename: (filename: string, taken: Set<string>) => {
    if (!taken.has(filename)) return filename;
    const dot = filename.lastIndexOf(".");
    const ext = dot > 0 ? filename.slice(dot) : "";
    const base = dot > 0 ? filename.slice(0, dot) : filename;
    let n = 1;
    let candidate = `${base} (${n})${ext}`;
    while (taken.has(candidate)) candidate = `${base} (${++n})${ext}`;
    return candidate;
  },
}));

import { InstanceKnowledgeController } from "./instance-knowledge.controller.js";

const instance = { slug: "acme", knowledgeEnabled: true };

describe("InstanceKnowledgeController.import", () => {
  let controller: InstanceKnowledgeController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new InstanceKnowledgeController();
    mockFindInstanceOrFail.mockResolvedValue(instance);
    mockResolveEmbeddingContext.mockResolvedValue({});
    mockListDocumentFilenames.mockResolvedValue([]);
    mockProcessDocument.mockResolvedValue(undefined);
    mockCreateDocument.mockImplementation(async (input: { filename: string }) => ({
      id: `id-${input.filename}`,
      filename: input.filename,
      status: "processing",
    }));
  });

  it("rejects when knowledge is disabled", async () => {
    mockFindInstanceOrFail.mockResolvedValue({ slug: "acme", knowledgeEnabled: false });
    await expect(
      controller.import("acme", { documents: [{ filename: "a.txt", content: "x" }] }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a malformed bundle", async () => {
    await expect(controller.import("acme", { documents: [] })).rejects.toThrow(BadRequestException);
    await expect(controller.import("acme", { nope: true })).rejects.toThrow(BadRequestException);
  });

  it("rejects when the embedder is not configured", async () => {
    mockResolveEmbeddingContext.mockRejectedValue(new Error("OpenAI API key required for embeddings"));
    await expect(
      controller.import("acme", { documents: [{ filename: "a.txt", content: "x" }] }),
    ).rejects.toThrow(/OpenAI API key required/);
    expect(mockCreateDocument).not.toHaveBeenCalled();
  });

  it("rejects when the import would exceed the per-instance cap", async () => {
    mockListDocumentFilenames.mockResolvedValue(["existing.txt"]);
    // cap=3, existing=1, importing=3 → 4 > 3
    await expect(
      controller.import("acme", {
        documents: [
          { filename: "a.txt", content: "x" },
          { filename: "b.txt", content: "y" },
          { filename: "c.txt", content: "z" },
        ],
      }),
    ).rejects.toThrow(/document limit/);
    expect(mockCreateDocument).not.toHaveBeenCalled();
  });

  it("imports documents, re-embeds each, and tags them as source=import", async () => {
    const res = await controller.import("acme", {
      version: 1,
      documents: [{ filename: "a.txt", content: " hello " }],
    });

    expect(res).toEqual({ imported: 1, documents: [{ filename: "a.txt" }] });
    expect(mockCreateDocument).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: "acme", filename: "a.txt", source: "import", rawContent: "hello" }),
    );
    expect(mockProcessDocument).toHaveBeenCalledWith("id-a.txt", "acme", "hello");
  });

  it("renames colliding filenames with a progressive suffix instead of overwriting", async () => {
    mockListDocumentFilenames.mockResolvedValue(["doc.txt"]);

    const res = await controller.import("acme", {
      documents: [
        { filename: "doc.txt", content: "one" },
        { filename: "doc.txt", content: "two" },
      ],
    });

    expect(res.documents).toEqual([
      { filename: "doc (1).txt", renamedFrom: "doc.txt" },
      { filename: "doc (2).txt", renamedFrom: "doc.txt" },
    ]);
  });
});
