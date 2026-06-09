// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const embedMock = vi.fn();
vi.mock("ai", () => ({ embed: (...a: unknown[]) => embedMock(...a), embedMany: vi.fn() }));
const embeddingFactory = vi.fn(() => "MODEL");
const createBedrock = vi.fn(() => ({ embedding: embeddingFactory }));
vi.mock("@ai-sdk/amazon-bedrock", () => ({ createAmazonBedrock: (...a: Parameters<typeof createBedrock>) => createBedrock(...a) }));
vi.mock("@aws-sdk/credential-providers", () => ({ fromNodeProviderChain: () => "CHAIN" }));

import { embedBedrock } from "./bedrock.js";

beforeEach(() => {
  embedMock.mockReset().mockResolvedValue({ embedding: [0.1] });
  createBedrock.mockClear();
  embeddingFactory.mockClear();
});

describe("embedBedrock", () => {
  it("uses Titan v2 with 1024 dims and explicit creds when provided", async () => {
    await embedBedrock("hi", { accessKeyId: "id", secretAccessKey: "sec", region: "eu-west-1", dimensions: 1024 });
    expect(createBedrock).toHaveBeenCalledWith(expect.objectContaining({ accessKeyId: "id", region: "eu-west-1" }));
    expect(embeddingFactory).toHaveBeenCalledWith("amazon.titan-embed-text-v2:0", { dimensions: 1024 });
  });
  it("falls back to the AWS provider chain without explicit creds", async () => {
    await embedBedrock("hi", { region: "eu-west-1", dimensions: 1024 });
    expect(createBedrock).toHaveBeenCalledWith(expect.objectContaining({ credentialProvider: "CHAIN" }));
  });
  it("rejects 1536 dims", async () => {
    await expect(embedBedrock("hi", { region: "eu-west-1", dimensions: 1536 })).rejects.toThrow(/does not support 1536/);
  });
});
