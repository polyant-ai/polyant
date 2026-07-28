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
    transaction: vi.fn(),
  };
  // transaction passes the mock db itself as the tx argument
  mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb));
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

vi.mock("../conversations/schema.js", () => ({
  conversations: { conversationId: "conversation_id", instanceId: "instance_id" },
  conversationMessages: { conversationId: "conversation_id" },
  conversationState: { instanceId: "instance_id", scope: "scope", scopeKey: "scope_key" },
}));

vi.mock("../memory/schema.js", () => ({
  memories: { instanceId: "instance_id", sourceConversationId: "source_conversation_id" },
}));

vi.mock("../knowledge/schema.js", () => ({
  knowledgeDocuments: { instanceId: "instance_id" },
}));

vi.mock("../scheduled-tasks/schema.js", () => ({
  scheduledTasks: { instanceId: "instance_id" },
}));

vi.mock("../organizations/organization.schema.js", () => ({
  organizations: { id: "id", isDefault: "is_default" },
  workspaces: {
    id: "id",
    organizationId: "organization_id",
    isDefault: "is_default",
    createdAt: "created_at",
  },
}));

// Sentinel instead of real SQL — the predicate itself is covered by
// authz/scope-filter.test.ts; here we only assert it is applied.
const { mockBuildOrgScopedAgentFilter } = vi.hoisted(() => ({
  mockBuildOrgScopedAgentFilter: vi.fn((orgId: string, column: string) => ({
    type: "orgFilter",
    orgId,
    column,
  })),
}));

vi.mock("../authz/scope-filter.js", () => ({
  buildOrgScopedAgentFilter: mockBuildOrgScopedAgentFilter,
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ type: "and", args: args.filter(Boolean) })),
  asc: vi.fn((col: unknown) => ({ type: "asc", col })),
  desc: vi.fn((col: unknown) => ({ type: "desc", col })),
  eq: vi.fn((...args: unknown[]) => ({ type: "eq", args })),
  inArray: vi.fn((col: unknown, values: unknown[]) => ({ type: "inArray", col, values })),
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
  resolveWorkspaceIdForPrincipal,
} from "./store.js";
import { asInstanceSlug } from "./identifiers.js";
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
  workspaceId: "ws-default",
  createdAt: new Date("2025-01-01"),
  updatedAt: new Date("2025-01-01"),
};

/** Mock the default-workspace lookup that ensureInstance/createInstance run
 *  before inserting (returns the seeded default workspace UUID). */
function mockDefaultWorkspaceSelect() {
  mockDb.select.mockReturnValue(createChainMock([{ id: "ws-default" }]) as any);
}

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

      const result = await findInstanceBySlug(asInstanceSlug("default"));

      expect(result).toEqual(fakeInstance);
      expect(mockDb.select).toHaveBeenCalled();
      expect(chain.from).toHaveBeenCalled();
      expect(chain.where).toHaveBeenCalled();
      expect(chain.limit).toHaveBeenCalledWith(1);
    });

    it("returns undefined when not found", async () => {
      const chain = createChainMock([]);
      mockDb.select.mockReturnValue(chain as any);

      const result = await findInstanceBySlug(asInstanceSlug("nonexistent"));

      expect(result).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // ensureInstance
  // -----------------------------------------------------------------------
  describe("ensureInstance", () => {
    it("inserts with onConflictDoNothing", async () => {
      mockDefaultWorkspaceSelect();
      const chain = createChainMock(undefined);
      mockDb.insert.mockReturnValue(chain as any);

      await ensureInstance({
        slug: asInstanceSlug("default"),
        name: "Default Assistant",
        description: "A default assistant",
      });

      expect(mockDb.insert).toHaveBeenCalled();
      expect(chain.values).toHaveBeenCalledWith({
        slug: "default",
        name: "Default Assistant",
        description: "A default assistant",
        embeddingDim: DEFAULT_EMBEDDING_DIM,
        workspaceId: "ws-default",
      });
      expect(chain.onConflictDoNothing).toHaveBeenCalled();
    });

    it("sets description to null when omitted", async () => {
      mockDefaultWorkspaceSelect();
      const chain = createChainMock(undefined);
      mockDb.insert.mockReturnValue(chain as any);

      await ensureInstance({ slug: asInstanceSlug("test"), name: "Test" });

      expect(chain.values).toHaveBeenCalledWith({
        slug: "test",
        name: "Test",
        description: null,
        embeddingDim: DEFAULT_EMBEDDING_DIM,
        workspaceId: "ws-default",
      });
    });
  });

  // -----------------------------------------------------------------------
  // createInstance
  // -----------------------------------------------------------------------
  describe("createInstance", () => {
    it("inserts and returns the created instance", async () => {
      mockDefaultWorkspaceSelect();
      const chain = createChainMock([fakeInstance]);
      mockDb.insert.mockReturnValue(chain as any);

      const result = await createInstance({
        slug: asInstanceSlug("default"),
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
        embeddingProvider: "openai",
        workspaceId: "ws-default",
      });
      expect(chain.returning).toHaveBeenCalled();
    });

    it("defaults description, provider, and model to null", async () => {
      mockDefaultWorkspaceSelect();
      const chain = createChainMock([{ ...fakeInstance, description: null, provider: null, model: null }]);
      mockDb.insert.mockReturnValue(chain as any);

      await createInstance({ slug: asInstanceSlug("minimal"), name: "Minimal" });

      expect(chain.values).toHaveBeenCalledWith({
        slug: "minimal",
        name: "Minimal",
        description: null,
        provider: null,
        model: null,
        embeddingDim: DEFAULT_EMBEDDING_DIM,
        embeddingProvider: "openai",
        workspaceId: "ws-default",
      });
    });

    it("should_insert_into_the_caller_org_workspace_when_an_orgId_is_given", async () => {
      mockDb.select.mockReturnValue(createChainMock([{ id: "ws-org-b" }]) as any);
      const chain = createChainMock([{ ...fakeInstance, workspaceId: "ws-org-b" }]);
      mockDb.insert.mockReturnValue(chain as any);

      await createInstance({ slug: asInstanceSlug("b-agent"), name: "B", orgId: "org-b" });

      expect(chain.values).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "ws-org-b" }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // resolveWorkspaceIdForPrincipal — a new agent must land in the CALLER's
  // workspace, never in the seed organization's default one.
  // -----------------------------------------------------------------------
  describe("resolveWorkspaceIdForPrincipal", () => {
    it("should_pick_a_workspace_of_the_caller_org_when_the_principal_carries_an_org", async () => {
      const chain = createChainMock([{ id: "ws-org-b" }]);
      mockDb.select.mockReturnValue(chain as any);

      const result = await resolveWorkspaceIdForPrincipal("org-b");

      expect(result).toBe("ws-org-b");
      // Constrained to org B's workspaces — not the deployment-wide is_default row.
      expect(chain.where).toHaveBeenCalledWith({
        type: "eq",
        args: ["organization_id", "org-b"],
      });
      // The org claim is authoritative: no organizations lookup is needed.
      expect(mockDb.select).toHaveBeenCalledTimes(1);
    });

    it("should_throw_when_the_caller_org_owns_no_workspace", async () => {
      mockDb.select.mockReturnValue(createChainMock([]) as any);

      await expect(resolveWorkspaceIdForPrincipal("org-b")).rejects.toThrow(/no workspace/i);
    });

    it("should_throw_when_the_principal_has_no_org_and_several_orgs_exist", async () => {
      mockDb.select.mockReturnValue(
        createChainMock([{ id: "org-1" }, { id: "org-2" }]) as any,
      );

      // Fail closed — picking the seeded default here is the cross-tenant write.
      await expect(resolveWorkspaceIdForPrincipal(undefined)).rejects.toThrow(
        /organization/i,
      );
    });

    it("should_use_the_only_organization_when_the_principal_carries_none", async () => {
      mockDb.select
        .mockReturnValueOnce(createChainMock([{ id: "org-only" }]) as any)
        .mockReturnValueOnce(createChainMock([{ id: "ws-only" }]) as any);

      await expect(resolveWorkspaceIdForPrincipal(undefined)).resolves.toBe("ws-only");
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

      const result = await updateInstance(asInstanceSlug("default"), { name: "Updated Name" });

      expect(result).toEqual(updatedInstance);
      expect(mockDb.update).toHaveBeenCalled();
      expect(chain.set).toHaveBeenCalled();
      expect(chain.where).toHaveBeenCalled();
      expect(chain.returning).toHaveBeenCalled();
    });

    it("returns undefined when slug not found", async () => {
      const chain = createChainMock([]);
      mockDb.update.mockReturnValue(chain as any);

      const result = await updateInstance(asInstanceSlug("nonexistent"), { name: "No Match" });

      expect(result).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // deleteInstance
  // -----------------------------------------------------------------------
  describe("deleteInstance", () => {
    it("runs in a transaction and returns true when the instance row is deleted", async () => {
      // No conversations for this instance → the conversation_messages delete is skipped.
      mockDb.select.mockReturnValue(createChainMock([]) as any);
      mockDb.delete.mockReturnValue(createChainMock([fakeInstance]) as any);

      const result = await deleteInstance(asInstanceSlug("default"));

      expect(result).toBe(true);
      expect(mockDb.transaction).toHaveBeenCalled();
      // conversations + memories + knowledge_documents + scheduled_tasks + conversation_state + principal_secrets + instances
      expect(mockDb.delete).toHaveBeenCalledTimes(7);
    });

    it("also deletes conversation_messages when the instance has conversations", async () => {
      mockDb.select.mockReturnValue(
        createChainMock([{ conversationId: "c1" }, { conversationId: "c2" }]) as any,
      );
      mockDb.delete.mockReturnValue(createChainMock([fakeInstance]) as any);

      const result = await deleteInstance(asInstanceSlug("default"));

      expect(result).toBe(true);
      // conversation_messages + conversations + memories + knowledge_documents + scheduled_tasks + conversation_state + principal_secrets + instances
      expect(mockDb.delete).toHaveBeenCalledTimes(8);
    });

    it("returns false when no instance row is deleted", async () => {
      mockDb.select.mockReturnValue(createChainMock([]) as any);
      mockDb.delete.mockReturnValue(createChainMock([]) as any);

      const result = await deleteInstance(asInstanceSlug("nonexistent"));

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

    it("should_constrain_the_listing_to_the_caller_org_when_an_orgId_is_given", async () => {
      const chain = createChainMock([fakeInstance]);
      mockDb.select.mockReturnValue(chain as any);

      await listAllInstances("org-a");

      expect(mockBuildOrgScopedAgentFilter).toHaveBeenCalledWith("org-a", "slug");
      expect(chain.where).toHaveBeenCalledWith({
        type: "orgFilter",
        orgId: "org-a",
        column: "slug",
      });
    });

    it("should_not_constrain_the_listing_when_no_orgId_is_given_by_a_system_caller", async () => {
      const chain = createChainMock([fakeInstance]);
      mockDb.select.mockReturnValue(chain as any);

      await listAllInstances();

      expect(mockBuildOrgScopedAgentFilter).not.toHaveBeenCalled();
      expect(chain.where).toHaveBeenCalledWith(undefined);
    });
  });

  // -----------------------------------------------------------------------
  // listActiveInstances — org scoping (feeds GET /v1/models)
  // -----------------------------------------------------------------------
  describe("listActiveInstances — organization scoping", () => {
    it("should_and_the_org_filter_with_the_active_status_when_an_orgId_is_given", async () => {
      const chain = createChainMock([fakeInstance]);
      mockDb.select.mockReturnValue(chain as any);

      await listActiveInstances("org-a");

      expect(mockBuildOrgScopedAgentFilter).toHaveBeenCalledWith("org-a", "slug");
      expect(chain.where).toHaveBeenCalledWith({
        type: "and",
        args: [
          { type: "eq", args: ["status", "active"] },
          { type: "orgFilter", orgId: "org-a", column: "slug" },
        ],
      });
    });
  });
});
