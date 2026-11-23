// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * When an embedding change counts as a new space, and which dimension it lands
 * on. The reset itself runs on Postgres in embedding-reset.service.integration.test.ts.
 */

import { describe, it, expect } from "vitest";
import { embeddingSpaceChanged, nextEmbeddingDim } from "./embedding-reset.service.js";

describe("embeddingSpaceChanged", () => {
  it("is true when the embedding provider changes (openai↔bedrock)", () => {
    expect(
      embeddingSpaceChanged(
        { embeddingProvider: "openai", embeddingDim: 1024 },
        { embeddingProvider: "bedrock", embeddingDim: 1024 },
      ),
    ).toBe(true);
  });

  it("is true when only the dimension changes: 1024 and 1536 vectors are not comparable", () => {
    expect(
      embeddingSpaceChanged(
        { embeddingProvider: "openai", embeddingDim: 1024 },
        { embeddingProvider: "openai", embeddingDim: 1536 },
      ),
    ).toBe(true);
  });

  it("is false when provider and dimension are unchanged (chat LLM may still differ)", () => {
    expect(
      embeddingSpaceChanged(
        { embeddingProvider: "bedrock", embeddingDim: 1024 },
        { embeddingProvider: "bedrock", embeddingDim: 1024 },
      ),
    ).toBe(false);
  });
});

describe("nextEmbeddingDim", () => {
  const stored = { embeddingProvider: "openai", embeddingDim: 1536 };

  it("takes the requested dimension when one is sent", () => {
    expect(nextEmbeddingDim(stored, "openai", 1024)).toBe(1024);
    expect(nextEmbeddingDim(stored, "bedrock", 1024)).toBe(1024);
  });

  it("keeps the stored dimension when the provider is unchanged and none is sent", () => {
    expect(nextEmbeddingDim(stored, "openai", undefined)).toBe(1536);
  });

  it("lands on the new provider's default on a switch with no dimension", () => {
    expect(nextEmbeddingDim(stored, "bedrock", undefined)).toBe(1024);
  });
});
