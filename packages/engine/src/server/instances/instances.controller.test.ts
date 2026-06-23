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
      tiers: { fast: "gpt-4o-mini", standard: "gpt-4o", heavy: "o1" },
      costPerMillionTokens: { "gpt-4o-mini": { input: 0.15, output: 0.6 } },
    },
    bedrock: {
      tiers: { fast: "titan", standard: "titan", heavy: "titan" },
      costPerMillionTokens: {},
    },
  },
}));

vi.mock("../../instances/store.js", () => ({
  listAllInstances: mockListAllInstances,
  findInstanceBySlug: mockFindInstanceBySlug,
  createInstance: mockCreateInstance,
  updateInstance: mockUpdateInstance,
  deleteInstance: mockDeleteInstance,
}));

vi.mock("../../instances/prompts.store.js", () => ({ seedInstancePrompts: mockSeedPrompts }));
vi.mock("../../instances/instance-tools.store.js", () => ({ seedInstanceTools: mockSeedTools }));
vi.mock("../../instances/instance-skills.store.js", () => ({ seedInstanceSkills: mockSeedSkills }));
vi.mock("../../instances/config-resolver.js", () => ({
  invalidateInstanceConfigCache: mockInvalidateCache,
}));
vi.mock("../../ai-gateway/config.js", () => ({ providerConfigs: mockProviderConfigs }));
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
        "authEnabled", "thinkingEnabled", "stateInPromptEnabled", "toolResultsInHistoryEnabled", "debugEnabled", "sttProvider", "embeddingDim", "icon", "createdAt", "updatedAt",
        "optoutEnabled", "optoutStopKeywords", "optoutResumeKeywords", "optoutClosingMessage", "optoutResumeMessage", "optoutInjectPromptHint",
        "memory",
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

      await expect(controller.update("test-one", { provider: "bedrock" })).rejects.toThrow(
        BadRequestException,
      );
      expect(mockUpdateInstance).not.toHaveBeenCalled();
      expect(mockResetEmbeddings).not.toHaveBeenCalled();
    });

    it("allows the switch and wipes when confirmWipe is set", async () => {
      mockFindInstanceBySlug
        .mockResolvedValueOnce(fullInstance)
        .mockResolvedValueOnce({ ...fullInstance, provider: "bedrock", embeddingDim: 1024 });
      mockUpdateInstance.mockResolvedValue({ ...fullInstance, provider: "bedrock" });
      mockEmbeddingProviderChanged.mockReturnValue(true);
      mockResetEmbeddings.mockResolvedValue({
        instanceId: "uuid-1",
        memoriesDeleted: 3,
        knowledgeDocumentsDeleted: 1,
        knowledgeChunksDeleted: 5,
        newEmbeddingDim: 1024,
      });

      const res = await controller.update("test-one", { provider: "bedrock", confirmWipe: true });

      expect(mockResetEmbeddings).toHaveBeenCalledWith("uuid-1", "bedrock");
      expect(res.wiped?.memoriesDeleted).toBe(3);
      // No data lookup needed when the caller already confirmed.
      expect(mockCountMemories).not.toHaveBeenCalled();
    });

    it("proceeds without confirmWipe when the switch leaves no data to lose", async () => {
      mockFindInstanceBySlug
        .mockResolvedValueOnce(fullInstance)
        .mockResolvedValueOnce({ ...fullInstance, provider: "bedrock" });
      mockUpdateInstance.mockResolvedValue({ ...fullInstance, provider: "bedrock" });
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

      const res = await controller.update("test-one", { provider: "bedrock" });

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
});
