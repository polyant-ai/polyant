// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Tenancy tests for importNewInstance.
 *
 * POST /api/instances/import used to create the agent in whatever workspace
 * carried `is_default = true` — a single row, owned by the organization seeded
 * by migration 0051. Any organization importing an agent therefore wrote into
 * the seed tenant. The workspace must come from the CALLER's organization, and
 * an unresolvable one must fail instead of falling back.
 */

// ---------------------------------------------------------------------------
// Chain mock helper (same shape as store.test.ts)
// ---------------------------------------------------------------------------
function createChainMock(resolvedValue: unknown = []) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const self = new Proxy(chain, {
    get(_target, prop: string) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => resolve(resolvedValue);
      }
      if (!chain[prop]) chain[prop] = vi.fn(() => self);
      return chain[prop];
    },
  });
  return self;
}

const { mockDb, mockResolveWorkspaceIdForPrincipal, mockRecomputeInstanceTools } = vi.hoisted(
  () => {
    const mockDb = {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      transaction: vi.fn(),
    };
    mockDb.transaction.mockImplementation(
      async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb),
    );
    return {
      mockDb,
      mockResolveWorkspaceIdForPrincipal: vi.fn(),
      mockRecomputeInstanceTools: vi.fn(),
    };
  },
);

vi.mock("../database/client.js", () => ({ db: mockDb }));
vi.mock("./store.js", () => ({
  resolveWorkspaceIdForPrincipal: mockResolveWorkspaceIdForPrincipal,
}));
vi.mock("./instance-tools.store.js", () => ({
  recomputeInstanceTools: mockRecomputeInstanceTools,
}));
vi.mock("./prompts.store.js", () => ({ invalidatePromptsCache: vi.fn() }));
vi.mock("./config-resolver.js", () => ({ invalidateInstanceConfigCache: vi.fn() }));
vi.mock("../hooks/hooks.store.js", () => ({ invalidateHooksCache: vi.fn() }));

import { importNewInstance } from "./import.service.js";
import { registerEmbeddingProvider } from "../embeddings-gateway/registry.js";

/** Minimal bundle — every optional section is defaulted by the Zod schema. */
function makeBundle() {
  return {
    version: "1.1" as const,
    exportedAt: "2026-07-28T00:00:00.000Z",
    type: "instance" as const,
    instance: {
      slug: "imported-agent",
      name: "Imported Agent",
      description: null,
      status: "active",
      provider: "openai",
      model: "gpt-4o",
      memoryEnabled: false,
      knowledgeEnabled: false,
      langsmithEnabled: false,
      authEnabled: false,
      prompts: [],
      skills: [],
      manualTools: [],
      secrets: [],
      channels: [],
      skillEnv: [],
      room: null,
      eventSources: [],
    },
  };
}

/** The values passed to the single `insert(instances).values(...)` call. */
function insertedValues(chain: ReturnType<typeof createChainMock>) {
  return (chain as unknown as Record<string, { mock: { calls: unknown[][] } }>).values.mock
    .calls[0][0] as Record<string, unknown>;
}

describe("importNewInstance — tenancy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.transaction.mockImplementation(
      async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb),
    );
    // resolveUniqueSlug's existence probe → no conflict.
    mockDb.select.mockReturnValue(createChainMock([]) as never);
  });

  it("should_create_the_agent_in_the_caller_org_workspace_when_an_org_b_caller_imports", async () => {
    mockResolveWorkspaceIdForPrincipal.mockResolvedValue("ws-org-b");
    const insertChain = createChainMock([{ id: "new-uuid" }]);
    mockDb.insert.mockReturnValue(insertChain as never);

    const result = await importNewInstance(makeBundle(), "org-b");

    expect(mockResolveWorkspaceIdForPrincipal).toHaveBeenCalledWith("org-b", mockDb);
    expect(insertedValues(insertChain).workspaceId).toBe("ws-org-b");
    expect(result.slug).toBe("imported-agent");
  });

  it("should_reject_the_import_when_the_workspace_cannot_be_resolved", async () => {
    mockResolveWorkspaceIdForPrincipal.mockRejectedValue(
      new Error("Cannot resolve the caller's organization"),
    );
    const insertChain = createChainMock([{ id: "new-uuid" }]);
    mockDb.insert.mockReturnValue(insertChain as never);

    await expect(importNewInstance(makeBundle(), undefined)).rejects.toThrow(
      /Cannot resolve the caller's organization/,
    );
    // Fail closed: no agent row is written to any fallback workspace.
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("preserves explicit capability values from an imported bundle", async () => {
    const bundle = makeBundle();
    bundle.instance.memoryEnabled = true;
    (bundle.instance as Record<string, unknown>).sttProvider = "deepgram";
    mockResolveWorkspaceIdForPrincipal.mockResolvedValue("ws-org-b");
    const insertChain = createChainMock([{ id: "new-uuid" }]);
    mockDb.insert.mockReturnValue(insertChain as never);

    await importNewInstance(bundle, "org-b");

    expect(insertedValues(insertChain)).toMatchObject({
      memoryEnabled: true,
      sttProvider: "deepgram",
    });
  });
});

describe("importNewInstance — the embedder the snapshot names", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.transaction.mockImplementation(
      async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb),
    );
    mockDb.select.mockReturnValue(createChainMock([]) as never);
    // `clearAllMocks` clears calls, not implementations, and the tenancy block
    // above leaves this one rejecting.
    mockResolveWorkspaceIdForPrincipal.mockReset().mockResolvedValue("ws-org-b");
  });

  // The defect: the bundle's `embeddingProvider` is a free string, and an
  // unknown one used to reach `resolveEmbeddingContext`, miss every branch and
  // fall through to OpenAI — so restoring a snapshot taken on a deployment that
  // serves another embedder quietly sent its memories and knowledge base to a
  // provider the agent was never configured for. Refused at the edge instead,
  // where the message can name what this deployment does serve.
  it("should_refuse_a_snapshot_whose_embedder_this_deployment_does_not_serve", async () => {
    const bundle = makeBundle();
    (bundle.instance as Record<string, unknown>).embeddingProvider = "an-embedder-nobody-serves";
    const insertChain = createChainMock([{ id: "new-uuid" }]);
    mockDb.insert.mockReturnValue(insertChain as never);

    await expect(importNewInstance(bundle, "org-b")).rejects.toThrow(
      /Embedding provider "an-embedder-nobody-serves" is not available in this deployment/,
    );
    // Fail closed: nothing is written, so a rejected restore leaves no agent
    // pointing at an embedder that cannot run.
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("should_accept_a_registered_embedder_and_store_it_as_named", async () => {
    registerEmbeddingProvider({
      name: "import-test-embedder",
      label: "Import Test Embedder",
      baseURL: "https://example.invalid/v1",
      modelId: "an-embedding-model",
      apiKeySecret: "import_test_embedder_api_key",
      supportedDims: [1024],
    });
    const bundle = makeBundle();
    (bundle.instance as Record<string, unknown>).embeddingProvider = "import-test-embedder";
    const insertChain = createChainMock([{ id: "new-uuid" }]);
    mockDb.insert.mockReturnValue(insertChain as never);

    await importNewInstance(bundle, "org-b");

    expect(insertedValues(insertChain).embeddingProvider).toBe("import-test-embedder");
  });

  // The positive half of the refusal: a snapshot with no embedder named at all
  // defaults to openai in the schema and must still import.
  it("should_accept_the_default_when_the_snapshot_names_no_embedder", async () => {
    const insertChain = createChainMock([{ id: "new-uuid" }]);
    mockDb.insert.mockReturnValue(insertChain as never);

    await importNewInstance(makeBundle(), "org-b");

    expect(insertedValues(insertChain).embeddingProvider).toBe("openai");
  });
});
