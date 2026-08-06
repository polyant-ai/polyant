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
  conversations: { conversationId: "conversation_id", instanceId: "agent_id" },
  conversationMessages: { conversationId: "conversation_id" },
  conversationState: { instanceId: "agent_id", scope: "scope", scopeKey: "scope_key" },
}));

vi.mock("../memory/schema.js", () => ({
  memories: { instanceId: "agent_id", sourceConversationId: "source_conversation_id" },
}));

vi.mock("../knowledge/schema.js", () => ({
  knowledgeDocuments: { instanceId: "agent_id" },
}));

vi.mock("../scheduled-tasks/schema.js", () => ({
  scheduledTasks: { instanceId: "agent_id" },
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
// The MOCKED `sql` tag — imported so a test can assert what was bound into a
// template predicate, which the marker-object mocks cannot express.
import { sql } from "drizzle-orm";
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

    // The ADDRESSED workspace — the segment in the URL the caller is on, arriving
    // as `X-Workspace-Slug`. It used to be ignored entirely, so an agent created
    // from `/workspaces/sandbox/instances` landed in the org's DEFAULT workspace
    // while the browser was pushed to a `sandbox` URL that misattributed it.
    it("should_use_the_addressed_workspace_when_it_belongs_to_the_caller_org", async () => {
      const chain = createChainMock([{ id: "ws-sandbox" }]);
      mockDb.select.mockReturnValue(chain as any);

      const result = await resolveWorkspaceIdForPrincipal("org-b", undefined, "sandbox");

      expect(result).toBe("ws-sandbox");
      // Constrained on BOTH the organization and the slug: matching the slug alone
      // would let one tenant file an agent under another's workspace, since the
      // slug is caller-controlled input.
      expect(chain.where).toHaveBeenCalledWith(
        expect.objectContaining({ type: "and" }),
      );
    });

    it("should_throw_when_the_addressed_workspace_is_not_the_caller_org's", async () => {
      // Nothing matches org + slug together — the workspace exists elsewhere, or
      // not at all. Both are refusals, and deliberately NOT a silent fall back to
      // the organization default: filing the agent somewhere other than the
      // address bar says is the bug this path exists to prevent.
      mockDb.select.mockReturnValue(createChainMock([]) as any);

      await expect(
        resolveWorkspaceIdForPrincipal("org-b", undefined, "someone-elses"),
      ).rejects.toThrow(/does not belong to the caller/i);
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
      // Combined through `and` now that a workspace filter can join it; with no
      // workspace addressed the org filter is the only term.
      expect(chain.where).toHaveBeenCalledWith({
        type: "and",
        args: [{ type: "orgFilter", orgId: "org-a", column: "slug" }],
      });
    });

    // The workspace NARROWS, it never widens: the org filter stays ANDed
    // underneath, so a slug belonging to another tenant matches nothing rather
    // than reaching across. Before this the URL's workspace was decorative and
    // `/workspaces/sandbox/instances` listed every agent in the organization.
    it("should_narrow_the_listing_to_the_addressed_workspace", async () => {
      const chain = createChainMock([fakeInstance]);
      mockDb.select.mockReturnValue(chain as any);
      vi.mocked(sql).mockClear();

      await listAllInstances("org-a", "sandbox");

      // The workspace predicate is a `sql` template, and the mocked `sql` returns
      // a marker-free value — so assert it was BUILT with the slug bound, which is
      // the part that matters. The org filter is asserted separately above.
      const boundSlug = vi
        .mocked(sql)
        .mock.calls.some((args) => args.slice(1).includes("sandbox"));
      expect(boundSlug, "the workspace slug must be bound into the predicate").toBe(true);
      expect(mockBuildOrgScopedAgentFilter).toHaveBeenCalledWith("org-a", "slug");
    });

    it("should_not_build_a_workspace_predicate_when_none_is_addressed", async () => {
      const chain = createChainMock([fakeInstance]);
      mockDb.select.mockReturnValue(chain as any);
      vi.mocked(sql).mockClear();

      await listAllInstances("org-a");

      // No workspace term. Asserted on the SQL TEXT rather than on "some string
      // was bound", because the ORDER BY template binds a column too.
      const builtWorkspaceTerm = vi
        .mocked(sql)
        .mock.calls.some((args) =>
          (args[0] as unknown as string[] | undefined)?.some?.((chunk) =>
            chunk.includes("workspaces"),
          ),
        );
      expect(builtWorkspaceTerm).toBe(false);
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
