// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const embedMock = vi.fn();
const embedManyMock = vi.fn();
vi.mock("ai", () => ({
  embed: (...a: unknown[]) => embedMock(...a),
  embedMany: (...a: unknown[]) => embedManyMock(...a),
}));
const embeddingFactory = vi.fn(() => "MODEL");
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => ({ embedding: embeddingFactory }),
}));

import { embedOpenAI, embedManyOpenAI } from "./openai.js";

beforeEach(() => {
  embedMock.mockReset().mockResolvedValue({ embedding: [0.1, 0.2] });
  embedManyMock.mockReset().mockResolvedValue({ embeddings: [[0.1], [0.2]] });
  embeddingFactory.mockClear();
});

describe("embedOpenAI", () => {
  it("passes the configured dimensions to the model factory", async () => {
    await embedOpenAI("hi", { apiKey: "k", dimensions: 1024 });
    expect(embeddingFactory).toHaveBeenCalledWith("text-embedding-3-small", { dimensions: 1024 });
  });
  it("throws without an api key", async () => {
    await expect(embedOpenAI("hi", { apiKey: "", dimensions: 1024 })).rejects.toThrow(/OpenAI API key/);
  });
});

describe("embedManyOpenAI", () => {
  it("returns [] for empty input without calling the SDK", async () => {
    expect(await embedManyOpenAI([], { apiKey: "k", dimensions: 1024 })).toEqual([]);
    expect(embedManyMock).not.toHaveBeenCalled();
  });
  it("uses embedMany for >1 text", async () => {
    const out = await embedManyOpenAI(["a", "b"], { apiKey: "k", dimensions: 1024 });
    expect(out).toEqual([[0.1], [0.2]]);
  });
});
