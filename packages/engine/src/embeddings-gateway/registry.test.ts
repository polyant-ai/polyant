// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeAll } from "vitest";
import { getEmbeddingProvider, registerEmbeddingProvider, registeredEmbeddingProviderNames } from "./registry.js";
import {
  assertDimSupported,
  embeddingProviderFor,
  isKnownEmbeddingProvider,
  knownEmbeddingProviders,
  supportedDimsFor,
} from "./config.js";
import { requiredSecretKeysFor } from "./provider-resolver.js";

const NAME = "embedder-registry-test";

beforeAll(() => {
  registerEmbeddingProvider({
    name: NAME,
    label: "Embedder Registry Test",
    baseURL: "https://example.invalid/v1",
    modelId: "an-embedding-model",
    apiKeySecret: "embedder_registry_test_api_key",
    supportedDims: [1024],
  });
});

describe("a registered embedder", () => {
  it("is known to the deployment, beside the two built-ins", () => {
    expect(registeredEmbeddingProviderNames()).toContain(NAME);
    expect(isKnownEmbeddingProvider(NAME)).toBe(true);
    expect(knownEmbeddingProviders()).toEqual(expect.arrayContaining(["openai", "bedrock", NAME]));
  });

  it("claims only the dimensions it declared", () => {
    // Which dimensions an embedder emits decides which vector column a row lands
    // in; a wrong length is not a failed call but an unsearchable row.
    expect(supportedDimsFor(NAME)).toEqual([1024]);
    expect(() => assertDimSupported(NAME, 1024)).not.toThrow();
    expect(() => assertDimSupported(NAME, 1536)).toThrow(/does not support 1536/);
  });

  it("asks for the key its registration names, which is the key the resolver reads", () => {
    // Readiness used to ask for `openai_api_key` for anything that was not
    // bedrock, and reported a working registered embedder as missing credentials.
    expect(requiredSecretKeysFor(NAME)).toEqual(["embedder_registry_test_api_key"]);
  });

  it("is chosen for a chat provider of the same name", () => {
    expect(embeddingProviderFor(NAME)).toBe(NAME);
  });

  it("refuses a built-in name", () => {
    expect(() =>
      registerEmbeddingProvider({ ...getEmbeddingProvider(NAME)!, name: "openai" }),
    ).toThrow(/built-in/);
  });
});

describe("the built-in embedders, unchanged", () => {
  it("keeps their dimensions and their credential rules", () => {
    expect(supportedDimsFor("bedrock")).toEqual([1024]);
    expect(requiredSecretKeysFor("openai")).toEqual(["openai_api_key"]);
    // Bedrock requires only the region: the access-key pair is optional, the
    // host's AWS profile or IAM role standing in for it.
    expect(requiredSecretKeysFor("bedrock")).toEqual(["aws_provider_region"]);
  });

  it("sends a chat provider that does not embed to OpenAI", () => {
    expect(embeddingProviderFor("anthropic")).toBe("openai");
    expect(embeddingProviderFor("bedrock")).toBe("bedrock");
    expect(embeddingProviderFor(null)).toBe("openai");
  });

  it("does not know an embedder nobody registered", () => {
    expect(isKnownEmbeddingProvider("nobody-registered-this")).toBe(false);
    expect(supportedDimsFor("nobody-registered-this")).toEqual([]);
  });
});
