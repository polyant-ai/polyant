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
    memoryEnabled: true,
    ...overrides,
  } as Instance;
}

describe("computeMemoryStatusFromInstance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockGetAllSecretsById.mockReset();
  });

  it("returns both false when memory is disabled (no secret lookup)", async () => {
    const instance = makeInstance({ memoryEnabled: false });

    const status = await computeMemoryStatusFromInstance(instance);

    expect(status).toEqual({ needsOpenAIKey: false, canEnable: false });
    expect(mockGetAllSecretsById).not.toHaveBeenCalled();
  });

  it("enables Bedrock memory when aws_region is configured", async () => {
    mockGetAllSecretsById.mockResolvedValue({ aws_region: "eu-west-1" });
    const instance = makeInstance({ provider: "bedrock" });

    const status = await computeMemoryStatusFromInstance(instance);

    expect(status).toEqual({ needsOpenAIKey: false, canEnable: true });
  });

  it("flags Bedrock memory as needing config when aws_region is missing", async () => {
    mockGetAllSecretsById.mockResolvedValue({});
    const instance = makeInstance({ provider: "bedrock" });

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
