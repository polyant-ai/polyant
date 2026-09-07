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
});
