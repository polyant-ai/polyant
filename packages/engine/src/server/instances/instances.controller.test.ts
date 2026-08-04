// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for InstancesController — covers the post-review guarantees:
//   #85: toInstanceDto whitelist (no leak of future schema fields)
//   #93: TOCTOU-free create (DB unique constraint, not pre-select)
//   #83: validateSlug applied to every :slug endpoint + length bound
//
// Dependencies are stubbed at the module boundary so we run pure controller
// logic without touching the DB.

const {
  mockFindInstanceBySlug,
  mockCreateInstance,
  mockUpdateInstance,
  mockDeleteInstance,
  mockListAllInstances,
  mockResolvePrincipalOrgId,
  mockSeedPrompts,
  mockSeedTools,
  mockSeedSkills,
  mockInvalidateCache,
  mockProviderConfigs,
  mockEmbeddingProviderChanged,
  mockResetEmbeddings,
  mockCountMemories,
  mockCountDocuments,
} = vi.hoisted(() => ({
  mockFindInstanceBySlug: vi.fn(),
  mockCreateInstance: vi.fn(),
  mockUpdateInstance: vi.fn(),
  mockDeleteInstance: vi.fn(),
  mockListAllInstances: vi.fn(),
  mockResolvePrincipalOrgId: vi.fn(),
  mockSeedPrompts: vi.fn(),
  mockSeedTools: vi.fn(),
  mockSeedSkills: vi.fn(),
  mockEmbeddingProviderChanged: vi.fn().mockReturnValue(false),
  mockResetEmbeddings: vi.fn(),
  mockCountMemories: vi.fn().mockResolvedValue(0),
  mockCountDocuments: vi.fn().mockResolvedValue(0),
  mockInvalidateCache: vi.fn(),
  mockProviderConfigs: {
    openai: {
      tiers: { fast: "gpt-4o-mini", standard: "gpt-4o", heavy: "o3" },
      models: {
        "gpt-4o-mini": { input: 0.15, output: 0.6 },
        "gpt-4o": { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
        "o3": { input: 2.0, output: 8.0 },
      },
    },
    bedrock: {
      tiers: { fast: "titan", standard: "titan", heavy: "titan" },
      models: { "openai.gpt-oss-120b-1:0": { input: 0.2, output: 0.79 } },
    },
  },
}));

vi.mock("../../instances/store.js", () => ({
  listAllInstances: mockListAllInstances,
  findInstanceBySlug: mockFindInstanceBySlug,
  createInstance: mockCreateInstance,
  updateInstance: mockUpdateInstance,
  deleteInstance: mockDeleteInstance,
  resolvePrincipalOrgId: mockResolvePrincipalOrgId,
}));

vi.mock("../../instances/prompts.store.js", () => ({ seedInstancePrompts: mockSeedPrompts }));
vi.mock("../../instances/instance-tools.store.js", () => ({ seedInstanceTools: mockSeedTools }));
vi.mock("../../instances/instance-skills.store.js", () => ({ seedInstanceSkills: mockSeedSkills }));
vi.mock("../../instances/config-resolver.js", () => ({
  invalidateInstanceConfigCache: mockInvalidateCache,
}));
vi.mock("../../ai-gateway/config.js", () => ({
  providerConfigs: mockProviderConfigs,
  isThinkingCapable: vi.fn().mockReturnValue(false),
  temperatureSupported: (provider: string, modelId: string, thinking: boolean): boolean => {
    if (provider === "openai" && /^(o[134]|gpt-5)/.test(modelId)) return false;
    // Under thinking, only open-weight reasoners (gpt-oss) keep a custom temperature.
    if (thinking) return /gpt-oss/i.test(modelId);
    return true;
  },
  clampTemperature: (value: number | null | undefined): number | null => {
    if (value == null || !Number.isFinite(value)) return null;
    return Math.min(2, Math.max(0, value));
  },
  cacheSupported: (provider: string, model: string): boolean =>
    provider === "bedrock" ? /anthropic|nova/.test(model) : provider !== "nebius",
  isReasoningAlwaysOn: (modelId: string): boolean => /gpt-oss/i.test(modelId),
  reasoningLevelsFor: (_provider: string, modelId: string): string[] =>
    /^(o[134]|gpt-5|claude|anthropic)/.test(modelId) ? ["low", "medium", "high"] : [],
}));
vi.mock("../../instances/icon-validator.js", () => ({ validateIconDataUri: vi.fn() }));
vi.mock("../../embeddings-gateway/provider-resolver.js", () => ({
  invalidateEmbeddingContext: vi.fn(),
}));
vi.mock("../../embeddings-gateway/embedding-reset.service.js", () => ({
  embeddingProviderChanged: mockEmbeddingProviderChanged,
  resetEmbeddingsForProviderSwitch: mockResetEmbeddings,
}));
vi.mock("../../memory/index.js", () => ({ countMemories: mockCountMemories }));
vi.mock("../../knowledge/index.js", () => ({ countDocuments: mockCountDocuments }));
// Stub the memory-status helper so getBySlug/update never touch the DB
// (computeMemoryStatusFromInstance reads instance_secrets).
vi.mock("../memories/memory-status.js", () => ({
  computeMemoryStatusFromInstance: vi
    .fn()
    .mockResolvedValue({ needsOpenAIKey: false, canEnable: true }),
  computeEmbedderStatus: vi.fn().mockResolvedValue({ needsCredentials: false }),
}));

import { InstancesController } from "./instances.controller.js";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";

const fullInstance = {
  id: "uuid-1",
  slug: "test-one",
  name: "Test One",
  description: "A test",
  status: "active",
  provider: "openai",
  model: "gpt-4o-mini",
  embeddingProvider: "openai",
  memoryEnabled: true,
  knowledgeEnabled: false,
  langsmithEnabled: false,
  langsmithProject: null,
  authEnabled: true,
  thinkingEnabled: false,
  stateInPromptEnabled: false,
  toolResultsInHistoryEnabled: false,
  icon: "data:image/png;base64,AAA=",
  // Simulated internal field — must NOT leak through the DTO.
  internalSecretFlag: "sensitive",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-04-20T12:00:00Z"),
};

describe("InstancesController", () => {
  let controller: InstancesController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new InstancesController();
  });

  // -------------------------------------------------------------------------
  // Org scoping — the aggregate list has no `:slug` for the guard to scope on,
  // so an unfiltered listAllInstances() enumerated every tenant's agents.
  // -------------------------------------------------------------------------
  describe("list — organization scoping", () => {
    const agentA = { ...fullInstance, slug: "agent-a" };
    const agentB = { ...fullInstance, slug: "agent-b" };

    beforeEach(() => {
      mockResolvePrincipalOrgId.mockImplementation(async (orgId?: string) => orgId ?? null);
      mockListAllInstances.mockImplementation(async (orgId?: string) =>
        orgId === "org-a" ? [agentA] : [agentA, agentB],
      );
    });

    it("should_not_expose_org_b_agents_when_an_org_a_caller_lists", async () => {
      const { instances } = await controller.list({
        userId: "u1",
        email: "a@example.com",
        principalType: "user",
        orgId: "org-a",
      });

      // Second argument is the addressed workspace; absent here, so undefined.
      expect(mockListAllInstances).toHaveBeenCalledWith("org-a", undefined);
      expect(instances.map((i) => i.slug)).toEqual(["agent-a"]);
    });

    it("should_return_no_agents_when_the_caller_organization_cannot_be_resolved", async () => {
      mockResolvePrincipalOrgId.mockResolvedValue(null);

      const { instances } = await controller.list(undefined);

      expect(instances).toEqual([]);
      // Fail closed: never fall through to the unscoped listing.
      expect(mockListAllInstances).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // #85 — DTO whitelist
  // -------------------------------------------------------------------------
  describe("toInstanceDto (#85)", () => {
    it("returns only whitelisted fields — future internal columns must not leak", async () => {
      mockFindInstanceBySlug.mockResolvedValue(fullInstance);

      const { instance } = await controller.getBySlug("test-one");

      // Allowed fields
      const allowed = new Set([
        "id", "slug", "name", "description", "status", "provider", "model",
        "memoryEnabled", "knowledgeEnabled", "langsmithEnabled", "langsmithProject",
        "authEnabled", "thinkingEnabled", "thinkingLevel", "temperature", "stateInPromptEnabled", "datetimeInjectionEnabled", "cacheEnabled", "cacheTtl", "toolResultsInHistoryEnabled", "debugEnabled", "sttProvider", "embeddingDim", "embeddingProvider", "icon", "createdAt", "updatedAt",
        "optoutEnabled", "optoutStopKeywords", "optoutResumeKeywords", "optoutClosingMessage", "optoutResumeMessage", "optoutInjectPromptHint",
        // Derived status blocks, not columns: `memory` is gated on the memory
        // flag, `embedder` is not — which is why the Knowledge tab needs it.
        "memory", "embedder",
      ]);

      for (const key of Object.keys(instance)) {
        expect(allowed.has(key)).toBe(true);
      }
      // The leak canary must be excluded.
      expect("internalSecretFlag" in instance).toBe(false);
    });

    it("emits icon as a URL + cache-busting query, never as the raw data URI", async () => {
      mockFindInstanceBySlug.mockResolvedValue(fullInstance);

      const { instance } = await controller.getBySlug("test-one");

      expect(instance.icon).toBe(
        `/api/instances/test-one/icon?v=${fullInstance.updatedAt.getTime()}`,
      );
      expect(instance.icon).not.toMatch(/^data:/);
    });

    it("icon is null when the instance has no icon stored", async () => {
      mockFindInstanceBySlug.mockResolvedValue({ ...fullInstance, icon: null });

      const { instance } = await controller.getBySlug("test-one");

      expect(instance.icon).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // #93 — TOCTOU-free create (DB unique constraint)
  // -------------------------------------------------------------------------
  describe("create (#93)", () => {
    // Creating an agent needs an owning organization; these cases are about the
    // duplicate-slug mapping, so give them a resolvable one by default. The
    // unresolvable case has its own test below.
    beforeEach(() => {
      mockResolvePrincipalOrgId.mockResolvedValue("org-a");
    });

    it("should_reject_with_400_when_the_caller_organization_cannot_be_resolved", async () => {
      // A principal with no org claim on a multi-org deployment: a caller-side
      // condition, so a 400 — never a 500, and never the seed workspace.
      mockResolvePrincipalOrgId.mockResolvedValue(null);

      await expect(
        controller.create({ slug: "orphan", name: "Orphan" }),
      ).rejects.toThrow(BadRequestException);
      expect(mockCreateInstance).not.toHaveBeenCalled();
    });

    it("does NOT pre-query for existence — only inserts", async () => {
      mockCreateInstance.mockResolvedValue({ ...fullInstance, slug: "new-one" });
      mockSeedPrompts.mockResolvedValue(undefined);
      mockSeedTools.mockResolvedValue(undefined);
      mockSeedSkills.mockResolvedValue(undefined);

      await controller.create({ slug: "new-one", name: "New" });

      // No read-before-write: findInstanceBySlug must never be called during create.
      expect(mockFindInstanceBySlug).not.toHaveBeenCalled();
      expect(mockCreateInstance).toHaveBeenCalledTimes(1);
    });

    it("maps PostgreSQL 23505 to ConflictException", async () => {
      const uniqueViolation = Object.assign(new Error("duplicate key"), { code: "23505" });
      mockCreateInstance.mockRejectedValue(uniqueViolation);

      await expect(
        controller.create({ slug: "dup", name: "Dup" }),
      ).rejects.toThrow(ConflictException);
    });

    it("maps Drizzle-wrapped PostgreSQL 23505 (on .cause) to ConflictException", async () => {
      // Drizzle 0.45 / postgres-js shape: top-level Error with .cause set to the
      // driver PostgresError. The SQLSTATE code lives on .cause, not on top.
      const driverError = Object.assign(new Error("duplicate key value violates unique constraint"), {
        code: "23505",
      });
      const wrapped = Object.assign(new Error("Failed query: insert into instances ..."), {
        cause: driverError,
      });
      mockCreateInstance.mockRejectedValue(wrapped);

      await expect(
        controller.create({ slug: "dup-wrapped", name: "Dup" }),
      ).rejects.toThrow(ConflictException);
    });

    it("should_create_the_agent_in_the_caller_organization_when_a_principal_is_present", async () => {
      mockCreateInstance.mockResolvedValue({ ...fullInstance, slug: "new-one" });
      mockResolvePrincipalOrgId.mockImplementation(async (orgId?: string) => orgId ?? null);

      await controller.create(
        // A hostile body cannot pick the target organization: the value from the
        // principal is applied last.
        { slug: "new-one", name: "New", orgId: "org-victim" } as never,
        { userId: "u1", email: "b@example.com", principalType: "user", orgId: "org-b" },
      );

      expect(mockCreateInstance).toHaveBeenCalledWith(
        expect.objectContaining({ slug: "new-one", orgId: "org-b" }),
      );
    });

    it("propagates non-unique-violation errors unchanged", async () => {
      mockCreateInstance.mockRejectedValue(new Error("some other db failure"));

      await expect(
        controller.create({ slug: "ok-slug", name: "Ok" }),
      ).rejects.toThrow("some other db failure");
    });
  });

  // -------------------------------------------------------------------------
  // #83 — validateSlug on every :slug endpoint + length bound
  // -------------------------------------------------------------------------
  describe("validateSlug (#83)", () => {
    const invalidSlugs: [string, string][] = [
      ["Has-Uppercase", "uppercase rejected"],
      ["-leading-hyphen", "leading hyphen rejected"],
      ["trailing-hyphen-", "trailing hyphen rejected"],
      ["has spaces", "spaces rejected"],
      ["has.dots", "dots rejected"],
      ["", "empty string rejected"],
      ["a".repeat(101), "over 100 chars rejected"],
    ];

    it.each(invalidSlugs)("getBySlug rejects %s (%s)", async (slug) => {
      await expect(controller.getBySlug(slug)).rejects.toThrow(BadRequestException);
      expect(mockFindInstanceBySlug).not.toHaveBeenCalled();
    });

    it.each(invalidSlugs)("update rejects %s (%s)", async (slug) => {
      await expect(controller.update(slug, {})).rejects.toThrow(BadRequestException);
      expect(mockUpdateInstance).not.toHaveBeenCalled();
    });

    it.each(invalidSlugs)("remove rejects %s (%s)", async (slug) => {
      await expect(controller.remove(slug)).rejects.toThrow(BadRequestException);
      expect(mockDeleteInstance).not.toHaveBeenCalled();
    });

    it("accepts valid slugs (single char, up to 100 chars)", async () => {
      mockFindInstanceBySlug.mockResolvedValue(fullInstance);
      await controller.getBySlug("a");
      await controller.getBySlug("a".repeat(100));
      await controller.getBySlug("valid-slug_1");
      expect(mockFindInstanceBySlug).toHaveBeenCalledTimes(3);
    });

    it("rejects a valid-format slug that does not exist with 404 (not 400)", async () => {
      mockFindInstanceBySlug.mockResolvedValue(undefined);
      await expect(controller.getBySlug("nonexistent")).rejects.toThrow(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // Embedding-provider switch — destructive wipe guard
  // -------------------------------------------------------------------------
  describe("update — embedding wipe guard", () => {
    it("rejects an embedding-provider switch with data and no confirmWipe (400)", async () => {
      mockFindInstanceBySlug.mockResolvedValue(fullInstance);
      mockEmbeddingProviderChanged.mockReturnValue(true);
      mockCountMemories.mockResolvedValue(3);

      await expect(controller.update("test-one", { embeddingProvider: "bedrock" })).rejects.toThrow(
        BadRequestException,
      );
      expect(mockUpdateInstance).not.toHaveBeenCalled();
      expect(mockResetEmbeddings).not.toHaveBeenCalled();
    });

    it("allows the switch and wipes when confirmWipe is set", async () => {
      mockFindInstanceBySlug
        .mockResolvedValueOnce(fullInstance)
        .mockResolvedValueOnce({ ...fullInstance, embeddingProvider: "bedrock", embeddingDim: 1024 });
      mockUpdateInstance.mockResolvedValue({ ...fullInstance, embeddingProvider: "bedrock" });
      mockEmbeddingProviderChanged.mockReturnValue(true);
      mockResetEmbeddings.mockResolvedValue({
        instanceId: "uuid-1",
        memoriesDeleted: 3,
        knowledgeDocumentsDeleted: 1,
        knowledgeChunksDeleted: 5,
        newEmbeddingDim: 1024,
      });

      const res = await controller.update("test-one", { embeddingProvider: "bedrock", confirmWipe: true });

      // Reset is called with (slug, uuid, newEmbeddingProvider).
      expect(mockResetEmbeddings).toHaveBeenCalledWith("test-one", "uuid-1", "bedrock");
      expect(res.wiped?.memoriesDeleted).toBe(3);
      // No data lookup needed when the caller already confirmed.
      expect(mockCountMemories).not.toHaveBeenCalled();
    });

    it("proceeds without confirmWipe when the switch leaves no data to lose", async () => {
      mockFindInstanceBySlug
        .mockResolvedValueOnce(fullInstance)
        .mockResolvedValueOnce({ ...fullInstance, embeddingProvider: "bedrock" });
      mockUpdateInstance.mockResolvedValue({ ...fullInstance, embeddingProvider: "bedrock" });
      mockEmbeddingProviderChanged.mockReturnValue(true);
      mockCountMemories.mockResolvedValue(0);
      mockCountDocuments.mockResolvedValue(0);
      mockResetEmbeddings.mockResolvedValue({
        instanceId: "uuid-1",
        memoriesDeleted: 0,
        knowledgeDocumentsDeleted: 0,
        knowledgeChunksDeleted: 0,
        newEmbeddingDim: 1024,
      });

      const res = await controller.update("test-one", { embeddingProvider: "bedrock" });

      expect(mockResetEmbeddings).toHaveBeenCalled();
      expect(res.wiped?.memoriesDeleted).toBe(0);
    });

    it("does not wipe when the embedding provider is unchanged", async () => {
      mockFindInstanceBySlug.mockResolvedValue(fullInstance);
      mockUpdateInstance.mockResolvedValue(fullInstance);
      mockEmbeddingProviderChanged.mockReturnValue(false);

      const res = await controller.update("test-one", { model: "gpt-4o" });

      expect(mockResetEmbeddings).not.toHaveBeenCalled();
      expect(res.wiped).toBeNull();
    });
  });
  // -------------------------------------------------------------------------
  // Temperature — clamp on PATCH, expose on GET
  // -------------------------------------------------------------------------
  describe("update — temperature clamping", () => {
    beforeEach(() => {
      mockFindInstanceBySlug.mockResolvedValue(fullInstance);
      mockUpdateInstance.mockResolvedValue(fullInstance);
      mockEmbeddingProviderChanged.mockReturnValue(false);
    });

    it("clamps temperature before persisting", async () => {
      await controller.update("test-one", { temperature: 5 });
      expect(mockUpdateInstance).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ temperature: 2 }),
      );
    });

    it("preserves temperature: 0 (boundary edge case)", async () => {
      await controller.update("test-one", { temperature: 0 });
      expect(mockUpdateInstance).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ temperature: 0 }),
      );
    });

    it("accepts null temperature (clear)", async () => {
      await controller.update("test-one", { temperature: null });
      expect(mockUpdateInstance).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ temperature: null }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Models endpoint — capability hints
  // -------------------------------------------------------------------------
  describe("getModels", () => {
    it("marks reasoning models as not supporting temperature", async () => {
      const res = controller.getModels();
      const openai = res.providers.openai.models;
      expect(openai.find((m) => m.id === "o3")?.supportsTemperature).toBe(false);
      expect(openai.find((m) => m.id === "gpt-4o")?.supportsTemperature).toBe(true);
    });

    it("exposes supportsTemperatureWithThinking per model (open-weight reasoners keep temperature)", () => {
      const res = controller.getModels();
      const openai = res.providers.openai.models;
      const bedrock = res.providers.bedrock.models;
      // Strict-reasoning API: temperature rejected once thinking is on.
      expect(openai.find((m) => m.id === "o3")?.supportsTemperatureWithThinking).toBe(false);
      // Open-weight reasoner (gpt-oss): temperature survives alongside reasoning.
      expect(bedrock.find((m) => m.id === "openai.gpt-oss-120b-1:0")?.supportsTemperatureWithThinking).toBe(true);
    });

    it("exposes absolute per-model cache costs (with input-rate fallback) and cache support", () => {
      const res = controller.getModels();
      const gpt4o = res.providers.openai.models.find((m) => m.id === "gpt-4o");
      expect(gpt4o?.supportsCache).toBe(true);
      expect(gpt4o?.costCacheRead).toBe(1.25); // absolute catalog rate
      expect(gpt4o?.costCacheWrite).toBe(0); // OpenAI pre-5.6 → no write premium
      // A model with no cache rates falls back to the full input rate.
      const o3 = res.providers.openai.models.find((m) => m.id === "o3");
      expect(o3?.costCacheRead).toBe(2.0);
      expect(o3?.costCacheWrite).toBe(2.0);
    });
  });
});
