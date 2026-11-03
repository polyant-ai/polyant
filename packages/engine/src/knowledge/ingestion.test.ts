// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { asInstanceSlug } from "../instances/identifiers.js";

const store = vi.hoisted(() => ({
  hashContent: (text: string) => `hash:${text}`,
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
  store.updateDocumentStatus.mockResolvedValue(true);
  store.touchDocument.mockResolvedValue(undefined);
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

  // A bundle import starts every document's ingestion at once; each one holds
  // its embeddings in memory and keeps provider calls in flight.
  it("indexes at most four documents at a time and finishes them all", async () => {
    let inFlight = 0;
    let peak = 0;
    embedMany.mockImplementation(async (batch: string[]) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return batch.map(() => [0.1]);
    });

    const passes = Array.from({ length: 10 }, (_, i) => processDocument(`doc-${i}`, asInstanceSlug("agent-a"), "text"));
    await Promise.all(passes);

    expect(peak).toBe(4);
    expect(store.insertChunksAndFinalize).toHaveBeenCalledTimes(10);
  });

  // The recovery fails a document nobody touched for minutes; a document
  // waiting for its turn is not abandoned.
  it("keeps a waiting document alive", async () => {
    vi.useFakeTimers();
    try {
      const release: Array<() => void> = [];
      embedMany.mockImplementation(
        (batch: string[]) => new Promise((resolve) => release.push(() => resolve(batch.map(() => [0.1])))),
      );
      const passes = Array.from({ length: 5 }, (_, i) => processDocument(`doc-${i}`, asInstanceSlug("agent-a"), "text"));
      await vi.advanceTimersByTimeAsync(0);
      store.touchDocument.mockClear();

      await vi.advanceTimersByTimeAsync(3 * 60_000);

      expect(store.touchDocument).toHaveBeenCalledWith("doc-4");
      embedMany.mockImplementation(async (batch: string[]) => batch.map(() => [0.1]));
      release.forEach((r) => r());
      await vi.runAllTimersAsync();
      await Promise.all(passes);
    } finally {
      vi.useRealTimers();
    }
  });
});
