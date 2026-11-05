// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const embedMock = vi.fn();
const embedManyMock = vi.fn();
vi.mock("ai", () => ({ embed: (...a: unknown[]) => embedMock(...a), embedMany: (...a: unknown[]) => embedManyMock(...a) }));
const embeddingFactory = vi.fn(() => "MODEL");
const createBedrock = vi.fn(() => ({ embedding: embeddingFactory }));
vi.mock("@ai-sdk/amazon-bedrock", () => ({ createAmazonBedrock: (...a: Parameters<typeof createBedrock>) => createBedrock(...a) }));
vi.mock("@aws-sdk/credential-providers", () => ({ fromNodeProviderChain: () => "CHAIN" }));

import { embedBedrock, embedManyBedrock } from "./bedrock.js";

beforeEach(() => {
  embedMock.mockReset().mockResolvedValue({ embedding: [0.1] });
  createBedrock.mockClear();
  embeddingFactory.mockClear();
});

describe("embedBedrock", () => {
  it("uses Titan v2 with 1024 dims and explicit creds when provided", async () => {
    await embedBedrock("hi", { accessKeyId: "id", secretAccessKey: "sec", region: "eu-west-1", dimensions: 1024 });
    expect(createBedrock).toHaveBeenCalledWith(expect.objectContaining({ accessKeyId: "id", region: "eu-west-1" }));
    expect(embeddingFactory).toHaveBeenCalledWith("amazon.titan-embed-text-v2:0");
    expect(embedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        value: "hi",
        providerOptions: { bedrock: { dimensions: 1024 } },
      }),
    );
  });
  it("falls back to the AWS provider chain without explicit creds", async () => {
    await embedBedrock("hi", { region: "eu-west-1", dimensions: 1024 });
    expect(createBedrock).toHaveBeenCalledWith(expect.objectContaining({ credentialProvider: "CHAIN" }));
  });
  // An agent authenticated only by a Bedrock API key used to embed through the
  // host's provider chain instead, so on a host without AWS credentials every
  // memory and knowledge write failed while chat worked on the same key.
  it("authenticates with the Bedrock API key when one is set, ahead of the key pair", async () => {
    await embedBedrock("hi", {
      apiKey: "bearer-token",
      accessKeyId: "id",
      secretAccessKey: "sec",
      region: "eu-west-1",
      dimensions: 1024,
    });
    expect(createBedrock).toHaveBeenCalledTimes(1);
    expect(createBedrock).toHaveBeenCalledWith({ apiKey: "bearer-token", region: "eu-west-1" });
  });
  it("uses the key pair, not the provider chain, when there is no API key", async () => {
    await embedBedrock("hi", { accessKeyId: "id", secretAccessKey: "sec", region: "eu-west-1", dimensions: 1024 });
    expect(createBedrock).toHaveBeenCalledWith({ apiKey: "", accessKeyId: "id", secretAccessKey: "sec", region: "eu-west-1" });
  });
  it("uses the provider chain only when there is neither an API key nor a key pair", async () => {
    await embedBedrock("hi", { apiKey: "  ", region: "eu-west-1", dimensions: 1024 });
    expect(createBedrock).toHaveBeenCalledWith({ region: "eu-west-1", credentialProvider: "CHAIN" });
  });
  it("rejects 1536 dims", async () => {
    await expect(embedBedrock("hi", { region: "eu-west-1", dimensions: 1536 })).rejects.toThrow(/does not support 1536/);
  });
});

describe("embedManyBedrock", () => {
  // Titan embeds one text per call, so the SDK turns a batch of 100 chunks into
  // 100 requests and, by default, sends them all at once.
  it("caps the provider calls a batch runs at once", async () => {
    embedManyMock.mockResolvedValueOnce({ embeddings: [[0.1], [0.2]], usage: { tokens: 2 } });
    await embedManyBedrock(["a", "b"], { region: "eu-west-1", dimensions: 1024 });
    expect(embedManyMock).toHaveBeenCalledWith(expect.objectContaining({ maxParallelCalls: 8 }));
  });
});
