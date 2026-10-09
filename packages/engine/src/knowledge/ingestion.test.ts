// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { asInstanceSlug } from "../instances/identifiers.js";

const store = vi.hoisted(() => ({
  deleteChunksByDocumentId: vi.fn(),
  getDocument: vi.fn(),
  insertChunksAndFinalize: vi.fn(),
  updateDocumentStatus: vi.fn(),
  touchDocument: vi.fn(),
}));
vi.mock("./store.js", () => store);
vi.mock("./chunker.js", () => ({
  chunkText: () => Array.from({ length: 250 }, (_, i) => ({ content: `chunk ${i}` })),
}));
const embedMany = vi.hoisted(() => vi.fn(async (batch: string[]) => batch.map(() => [0.1])));
vi.mock("../embeddings-gateway/index.js", () => ({
  embedMany,
  resolveEmbeddingContext: async () => ({ dimensions: 1536, providerName: "openai" }),
}));

import { processDocument } from "./ingestion.js";

beforeEach(() => {
  vi.clearAllMocks();
  store.getDocument.mockResolvedValue({ filename: "a.txt" });
  store.insertChunksAndFinalize.mockResolvedValue(250);
});

describe("processDocument", () => {
  // The recovery fails a document nobody touched for minutes. A long document
  // embedded in many batches has to keep saying it is alive, or another
  // replica's recovery would fail it mid-ingestion.
  it("reports progress after every embedding batch", async () => {
    await processDocument("doc-1", asInstanceSlug("agent-a"), "text");

    expect(embedMany).toHaveBeenCalledTimes(3);
    expect(store.touchDocument).toHaveBeenCalledTimes(3);
    expect(store.touchDocument).toHaveBeenCalledWith("doc-1");
  });
});
