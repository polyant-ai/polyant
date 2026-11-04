// SPDX-License-Identifier: AGPL-3.0-or-later

// The decisions a PATCH of an agent's settings takes before and while it
// writes: which changes are refused, when the embedding space is reset, and
// what the caller gets back. The store, the data counts and the reset itself
// are stubbed; the provider and embedder catalogs are the real ones.

const { mockFindInstanceBySlug, mockUpdateInstance, mockResetEmbeddings, mockCountMemories, mockCountDocuments } =
  vi.hoisted(() => ({
    mockFindInstanceBySlug: vi.fn(),
    mockUpdateInstance: vi.fn(),
    mockResetEmbeddings: vi.fn(),
    mockCountMemories: vi.fn(),
    mockCountDocuments: vi.fn(),
  }));

vi.mock("./store.js", () => ({ findInstanceBySlug: mockFindInstanceBySlug, updateInstance: mockUpdateInstance }));
vi.mock("./config-resolver.js", () => ({ invalidateInstanceConfigCache: vi.fn() }));
vi.mock("../embeddings-gateway/provider-resolver.js", () => ({ invalidateEmbeddingContext: vi.fn() }));
vi.mock(import("../embeddings-gateway/embedding-reset.service.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  resetEmbeddingSpace: mockResetEmbeddings,
}));
vi.mock("../memory/index.js", () => ({ countMemories: mockCountMemories }));
vi.mock("../knowledge/index.js", () => ({ countDocuments: mockCountDocuments }));

import { providerConfigs } from "../ai-gateway/config.js";
import {
  InvalidInstanceSettingsError,
  normalizeInstancePatch,
  planInstancePatch,
  resetPlannedEmbeddingSpace,
  writeInstancePatch,
} from "./instance-update.js";
import type { Instance } from "./store.js";

const [providerA, providerB] = Object.keys(providerConfigs);
const modelOf = (provider: string) => Object.keys(providerConfigs[provider].models)[0];

const agent = {
  id: "uuid-1",
  slug: "agent-one",
  provider: providerA,
  model: modelOf(providerA),
  embeddingProvider: "openai",
  embeddingDim: 1024,
} as unknown as Instance;

beforeEach(() => {
  vi.resetAllMocks();
  mockCountMemories.mockResolvedValue(0);
  mockCountDocuments.mockResolvedValue(0);
});

describe("normalizeInstancePatch", () => {
  it("refuses an embedder this deployment cannot use", () => {
    expect(() => normalizeInstancePatch({ embeddingProvider: "no-such-embedder" })).toThrow(
      InvalidInstanceSettingsError,
    );
  });

  it("clamps the temperature into the range the gateway sends", () => {
    expect(normalizeInstancePatch({ temperature: 7 }).temperature).toBe(2);
  });
});

describe("planInstancePatch", () => {
  it("refuses a model of a provider other than the one the agent runs on", async () => {
    await expect(planInstancePatch(agent, { model: modelOf(providerB) })).rejects.toThrow(
      new RegExp(`for provider "${providerA}"`),
    );
  });

  it("refuses an embedder switch that would delete existing data without confirmation", async () => {
    mockCountMemories.mockResolvedValue(4);

    await expect(planInstancePatch(agent, { embeddingProvider: "bedrock" })).rejects.toThrow(/confirmWipe/);
  });

  it("plans a reset at the new embedder's dimension when the switch is confirmed", async () => {
    const plan = await planInstancePatch({ ...agent, embeddingDim: 1536 } as Instance, {
      embeddingProvider: "bedrock",
      confirmWipe: true,
    });

    expect(plan).toEqual({ embeddingProvider: "bedrock", embeddingDim: 1024, willWipe: true });
    expect(mockCountMemories).not.toHaveBeenCalled();
  });

  it("plans no reset and reads no data for a change outside the embedding space", async () => {
    const plan = await planInstancePatch(agent, { name: "Renamed" });

    expect(plan.willWipe).toBe(false);
    expect(mockCountMemories).not.toHaveBeenCalled();
    expect(mockCountDocuments).not.toHaveBeenCalled();
  });
});

describe("writeInstancePatch and resetPlannedEmbeddingSpace", () => {
  const resetResult = {
    instanceId: "uuid-1",
    memoriesDeleted: 2,
    knowledgeDocumentsDeleted: 0,
    knowledgeChunksDeleted: 0,
    newEmbeddingDim: 1536,
  };

  it("writes without resetting, and resets at the planned dimension only in the second step", async () => {
    mockUpdateInstance.mockResolvedValue(agent);
    mockResetEmbeddings.mockResolvedValue(resetResult);
    mockFindInstanceBySlug.mockResolvedValue({ ...agent, embeddingDim: 1536 });

    const written = await writeInstancePatch(agent, { embeddingDim: 1536, confirmWipe: true });
    expect(written).toBe(agent);
    expect(mockResetEmbeddings).not.toHaveBeenCalled();

    const result = await resetPlannedEmbeddingSpace(written!, {
      embeddingProvider: "openai",
      embeddingDim: 1536,
      willWipe: true,
    });

    expect(mockResetEmbeddings).toHaveBeenCalledWith("agent-one", "uuid-1", 1536);
    expect(result.instance.embeddingDim).toBe(1536);
    expect(result.wiped).toEqual(resetResult);
  });

  it("returns the written row untouched when the plan keeps the embedding space", async () => {
    const result = await resetPlannedEmbeddingSpace(agent, {
      embeddingProvider: "openai",
      embeddingDim: 1024,
      willWipe: false,
    });

    expect(result).toEqual({ instance: agent, wiped: null });
    expect(mockResetEmbeddings).not.toHaveBeenCalled();
  });

  it("returns null when the agent is gone by the time it writes", async () => {
    mockUpdateInstance.mockResolvedValue(undefined);

    expect(await writeInstancePatch(agent, { name: "Renamed" })).toBeNull();
  });
});
