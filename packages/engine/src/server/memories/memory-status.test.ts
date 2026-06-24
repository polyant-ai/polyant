// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Instance } from "../../instances/store.js";

const { mockGetAllSecretsById, mockFindInstanceByIdOrSlug } = vi.hoisted(() => ({
  mockGetAllSecretsById: vi.fn(),
  mockFindInstanceByIdOrSlug: vi.fn(),
}));

vi.mock("../../instances/secrets.store.js", () => ({
  getAllSecretsById: mockGetAllSecretsById,
  SECRET_KEYS: {
    OPENAI_API_KEY: "openai_api_key",
    AWS_REGION: "aws_region",
  },
}));

vi.mock("../../instances/resolve-instance-id.js", () => ({
  findInstanceByIdOrSlug: mockFindInstanceByIdOrSlug,
}));

import {
  computeMemoryStatusFromInstance,
  computeMemoryStatus,
} from "./memory-status.js";

function makeInstance(overrides: Partial<Instance>): Instance {
  return {
    id: "uuid-1",
    provider: "openai",
    embeddingProvider: "openai",
    memoryEnabled: true,
    embeddingDim: 1024, // compatible with both openai and bedrock by default
    ...overrides,
  } as Instance;
}

describe("computeMemoryStatusFromInstance", () => {
  let prevAwsRegion: string | undefined;
  beforeEach(() => {
    // Make the engine-level AWS_REGION fallback deterministic regardless of the
    // host/CI environment; individual tests opt in by setting it.
    prevAwsRegion = process.env.AWS_REGION;
    delete process.env.AWS_REGION;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    mockGetAllSecretsById.mockReset();
    if (prevAwsRegion === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = prevAwsRegion;
  });

  it("returns both false when memory is disabled (no secret lookup)", async () => {
    const instance = makeInstance({ memoryEnabled: false });

    const status = await computeMemoryStatusFromInstance(instance);

    expect(status).toEqual({ needsOpenAIKey: false, canEnable: false });
    expect(mockGetAllSecretsById).not.toHaveBeenCalled();
  });

  it("enables Bedrock memory when aws_region is configured", async () => {
    mockGetAllSecretsById.mockResolvedValue({ aws_region: "eu-west-1" });
    const instance = makeInstance({ provider: "bedrock", embeddingProvider: "bedrock" });

    const status = await computeMemoryStatusFromInstance(instance);

    expect(status).toEqual({ needsOpenAIKey: false, canEnable: true });
  });

  it("flags Bedrock memory as needing config when aws_region is missing", async () => {
    mockGetAllSecretsById.mockResolvedValue({});
    const instance = makeInstance({ provider: "bedrock", embeddingProvider: "bedrock" });

    const status = await computeMemoryStatusFromInstance(instance);

    expect(status).toEqual({ needsOpenAIKey: true, canEnable: false });
  });

  it("enables OpenAI memory when openai_api_key is configured", async () => {
    mockGetAllSecretsById.mockResolvedValue({ openai_api_key: "sk-test" });
    const instance = makeInstance({ provider: "openai" });

    const status = await computeMemoryStatusFromInstance(instance);

    expect(status).toEqual({ needsOpenAIKey: false, canEnable: true });
  });

  it("flags OpenAI memory as needing a key when openai_api_key is missing", async () => {
    mockGetAllSecretsById.mockResolvedValue({});
    const instance = makeInstance({ provider: "openai" });

    const status = await computeMemoryStatusFromInstance(instance);

    expect(status).toEqual({ needsOpenAIKey: true, canEnable: false });
  });

  it("flags Anthropic memory as needing an OpenAI key when missing", async () => {
    mockGetAllSecretsById.mockResolvedValue({});
    const instance = makeInstance({ provider: "anthropic" });

    const status = await computeMemoryStatusFromInstance(instance);

    expect(status).toEqual({ needsOpenAIKey: true, canEnable: false });
  });

  it("reports canEnable:false when the dim is unsupported by the provider (bedrock + 1536)", async () => {
    // Defensive guard: should an instance ever end up bedrock + embedding_dim=1536
    // (a dim Titan v2 cannot emit), it is unembeddable. Credentials are present,
    // so without the dim guard this would falsely report healthy.
    mockGetAllSecretsById.mockResolvedValue({ aws_region: "eu-west-1" });
    const instance = makeInstance({ provider: "bedrock", embeddingProvider: "bedrock", embeddingDim: 1536 });

    const status = await computeMemoryStatusFromInstance(instance);

    expect(status.canEnable).toBe(false);
  });

  it("enables Bedrock memory via the engine-level AWS_REGION fallback when no per-instance region is set", async () => {
    // Mirrors resolveEmbeddingContext: a region on the engine env is sufficient.
    mockGetAllSecretsById.mockResolvedValue({});
    const instance = makeInstance({ provider: "bedrock", embeddingProvider: "bedrock" });
    const prev = process.env.AWS_REGION;
    process.env.AWS_REGION = "us-east-1";
    try {
      const status = await computeMemoryStatusFromInstance(instance);
      expect(status).toEqual({ needsOpenAIKey: false, canEnable: true });
    } finally {
      if (prev === undefined) delete process.env.AWS_REGION;
      else process.env.AWS_REGION = prev;
    }
  });
});

describe("computeMemoryStatus", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockGetAllSecretsById.mockReset();
    mockFindInstanceByIdOrSlug.mockReset();
  });

  it("returns both false when the instance does not exist", async () => {
    mockFindInstanceByIdOrSlug.mockResolvedValue(undefined);

    const status = await computeMemoryStatus("ghost");

    expect(status).toEqual({ needsOpenAIKey: false, canEnable: false });
    expect(mockGetAllSecretsById).not.toHaveBeenCalled();
  });

  it("delegates to the loaded instance when it exists", async () => {
    mockFindInstanceByIdOrSlug.mockResolvedValue(
      makeInstance({ provider: "openai" }),
    );
    mockGetAllSecretsById.mockResolvedValue({ openai_api_key: "sk-test" });

    const status = await computeMemoryStatus("my-bot");

    expect(status).toEqual({ needsOpenAIKey: false, canEnable: true });
  });
});
