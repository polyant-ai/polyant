// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for packages/engine/src/instances/store.ts
 *
 * Tests all 7 exported functions: listActiveInstances, findInstanceBySlug,
 * ensureInstance, createInstance, updateInstance, deleteInstance, listAllInstances.
 */

// ---------------------------------------------------------------------------
// Chain mock helper
// ---------------------------------------------------------------------------
function createChainMock(resolvedValue: unknown = []) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const self = new Proxy(chain, {
    get(_target, prop: string) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => resolve(resolvedValue);
      }
      if (!chain[prop]) {
        chain[prop] = vi.fn(() => self);
      }
      return chain[prop];
    },
  });
  return self;
}

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { mockDb } = vi.hoisted(() => {
  const mockDb = {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  };
  return { mockDb };
});

vi.mock("../database/client.js", () => ({ db: mockDb }));

vi.mock("./schema.js", () => ({
  instances: {
    id: "id",
    slug: "slug",
    name: "name",
    description: "description",
    status: "status",
    provider: "provider",
    model: "model",
    memoryEnabled: "memory_enabled",
    knowledgeEnabled: "knowledge_enabled",
    langsmithEnabled: "langsmith_enabled",
    langsmithProject: "langsmith_project",
    authEnabled: "auth_enabled",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ type: "eq", args })),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
import {
  listActiveInstances,
  findInstanceBySlug,
  ensureInstance,
  createInstance,
  updateInstance,
  deleteInstance,
  listAllInstances,
} from "./store.js";
import { DEFAULT_EMBEDDING_DIM } from "../embeddings-gateway/config.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const fakeInstance = {
  id: "uuid-1",
  slug: "default",
  name: "Default Assistant",
  description: "A default assistant",
  status: "active",
  provider: "openai",
  model: "gpt-4o",
  memoryEnabled: true,
  knowledgeEnabled: false,
  langsmithEnabled: false,
  langsmithProject: null,
  authEnabled: false,
  createdAt: new Date("2025-01-01"),
  updatedAt: new Date("2025-01-01"),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("instances/store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // listActiveInstances
  // -----------------------------------------------------------------------
  describe("listActiveInstances", () => {
    it("returns all active instances", async () => {
      const chain = createChainMock([fakeInstance]);
      mockDb.select.mockReturnValue(chain as any);

      const result = await listActiveInstances();

      expect(result).toEqual([fakeInstance]);
      expect(mockDb.select).toHaveBeenCalled();
      expect(chain.from).toHaveBeenCalled();
      expect(chain.where).toHaveBeenCalled();
    });

    it("returns empty array when no active instances", async () => {
      const chain = createChainMock([]);
      mockDb.select.mockReturnValue(chain as any);

      const result = await listActiveInstances();

      expect(result).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // findInstanceBySlug
  // -----------------------------------------------------------------------
  describe("findInstanceBySlug", () => {
    it("returns the instance when found", async () => {
      const chain = createChainMock([fakeInstance]);
      mockDb.select.mockReturnValue(chain as any);

      const result = await findInstanceBySlug("default");

      expect(result).toEqual(fakeInstance);
      expect(mockDb.select).toHaveBeenCalled();
      expect(chain.from).toHaveBeenCalled();
      expect(chain.where).toHaveBeenCalled();
      expect(chain.limit).toHaveBeenCalledWith(1);
    });

    it("returns undefined when not found", async () => {
      const chain = createChainMock([]);
      mockDb.select.mockReturnValue(chain as any);

      const result = await findInstanceBySlug("nonexistent");

      expect(result).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // ensureInstance
  // -----------------------------------------------------------------------
  describe("ensureInstance", () => {
    it("inserts with onConflictDoNothing", async () => {
      const chain = createChainMock(undefined);
      mockDb.insert.mockReturnValue(chain as any);

      await ensureInstance({
        slug: "default",
        name: "Default Assistant",
        description: "A default assistant",
      });

      expect(mockDb.insert).toHaveBeenCalled();
      expect(chain.values).toHaveBeenCalledWith({
        slug: "default",
        name: "Default Assistant",
        description: "A default assistant",
        embeddingDim: DEFAULT_EMBEDDING_DIM,
      });
      expect(chain.onConflictDoNothing).toHaveBeenCalled();
    });

    it("sets description to null when omitted", async () => {
      const chain = createChainMock(undefined);
      mockDb.insert.mockReturnValue(chain as any);

      await ensureInstance({ slug: "test", name: "Test" });

      expect(chain.values).toHaveBeenCalledWith({
        slug: "test",
        name: "Test",
        description: null,
        embeddingDim: DEFAULT_EMBEDDING_DIM,
      });
    });
  });

  // -----------------------------------------------------------------------
  // createInstance
  // -----------------------------------------------------------------------
  describe("createInstance", () => {
    it("inserts and returns the created instance", async () => {
      const chain = createChainMock([fakeInstance]);
      mockDb.insert.mockReturnValue(chain as any);

      const result = await createInstance({
        slug: "default",
        name: "Default Assistant",
        description: "A default assistant",
        provider: "openai",
        model: "gpt-4o",
      });

      expect(result).toEqual(fakeInstance);
      expect(mockDb.insert).toHaveBeenCalled();
      expect(chain.values).toHaveBeenCalledWith({
        slug: "default",
        name: "Default Assistant",
        description: "A default assistant",
        provider: "openai",
        model: "gpt-4o",
        embeddingDim: DEFAULT_EMBEDDING_DIM,
      });
      expect(chain.returning).toHaveBeenCalled();
    });

    it("defaults description, provider, and model to null", async () => {
      const chain = createChainMock([{ ...fakeInstance, description: null, provider: null, model: null }]);
      mockDb.insert.mockReturnValue(chain as any);

      await createInstance({ slug: "minimal", name: "Minimal" });

      expect(chain.values).toHaveBeenCalledWith({
        slug: "minimal",
        name: "Minimal",
        description: null,
        provider: null,
        model: null,
        embeddingDim: DEFAULT_EMBEDDING_DIM,
      });
    });
  });

  // -----------------------------------------------------------------------
  // updateInstance
  // -----------------------------------------------------------------------
  describe("updateInstance", () => {
    it("updates and returns the updated instance", async () => {
      const updatedInstance = { ...fakeInstance, name: "Updated Name" };
      const chain = createChainMock([updatedInstance]);
      mockDb.update.mockReturnValue(chain as any);

      const result = await updateInstance("default", { name: "Updated Name" });

      expect(result).toEqual(updatedInstance);
      expect(mockDb.update).toHaveBeenCalled();
      expect(chain.set).toHaveBeenCalled();
      expect(chain.where).toHaveBeenCalled();
      expect(chain.returning).toHaveBeenCalled();
    });

    it("returns undefined when slug not found", async () => {
      const chain = createChainMock([]);
      mockDb.update.mockReturnValue(chain as any);

      const result = await updateInstance("nonexistent", { name: "No Match" });

      expect(result).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // deleteInstance
  // -----------------------------------------------------------------------
  describe("deleteInstance", () => {
    it("returns true when a row is deleted", async () => {
      const chain = createChainMock([fakeInstance]);
      mockDb.delete.mockReturnValue(chain as any);

      const result = await deleteInstance("default");

      expect(result).toBe(true);
      expect(mockDb.delete).toHaveBeenCalled();
      expect(chain.where).toHaveBeenCalled();
      expect(chain.returning).toHaveBeenCalled();
    });

    it("returns false when no row is deleted", async () => {
      const chain = createChainMock([]);
      mockDb.delete.mockReturnValue(chain as any);

      const result = await deleteInstance("nonexistent");

      expect(result).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // listAllInstances
  // -----------------------------------------------------------------------
  describe("listAllInstances", () => {
    it("returns all instances ordered by name (case-insensitive)", async () => {
      const allInstances = [fakeInstance, { ...fakeInstance, slug: "creative" }];
      const chain = createChainMock(allInstances);
      mockDb.select.mockReturnValue(chain as any);

      const result = await listAllInstances();

      expect(result).toEqual(allInstances);
      expect(mockDb.select).toHaveBeenCalled();
      expect(chain.from).toHaveBeenCalled();
      expect(chain.orderBy).toHaveBeenCalled();
    });

    it("returns empty array when no instances exist", async () => {
      const chain = createChainMock([]);
      mockDb.select.mockReturnValue(chain as any);

      const result = await listAllInstances();

      expect(result).toEqual([]);
    });
  });
});
