// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Coverage for `resolveUniqueSlug`, the slug-collision probe that runs on the
 * root `db` before `importNewInstance` opens its transaction.
 *
 * The function is not exported — it is an internal helper of
 * `import.service.ts` — so per the task instructions it is driven indirectly
 * through `importNewInstance`, whose returned `slug` reveals which candidate
 * won. We do not export it solely to make it testable.
 */

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

const { mockDb, mockResolveWorkspaceIdForPrincipal } = vi.hoisted(() => {
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    transaction: vi.fn(),
  };
  mockDb.transaction.mockImplementation(
    async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb),
  );
  return { mockDb, mockResolveWorkspaceIdForPrincipal: vi.fn() };
});

vi.mock("../database/client.js", () => ({ db: mockDb }));
vi.mock("./store.js", () => ({ resolveWorkspaceIdForPrincipal: mockResolveWorkspaceIdForPrincipal }));
vi.mock("./instance-tools.store.js", () => ({ recomputeInstanceTools: vi.fn() }));
vi.mock("./prompts.store.js", () => ({ invalidatePromptsCache: vi.fn() }));
vi.mock("../hooks/hooks.store.js", () => ({ invalidateHooksCache: vi.fn() }));

import { importNewInstance } from "./import.service.js";

function makeBundle(slug: string) {
  return {
    version: "1.1" as const,
    exportedAt: "2026-07-28T00:00:00.000Z",
    type: "instance" as const,
    instance: {
      slug,
      name: "Agent",
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

/** Queue successive `db.select(...)` resolutions, one per slug probe. */
function queueSelectResults(results: unknown[][]) {
  const queue = [...results];
  mockDb.select.mockImplementation(() => createChainMock(queue.shift() ?? []) as never);
}

describe("resolveUniqueSlug (driven through importNewInstance)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.transaction.mockImplementation(
      async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb),
    );
    mockResolveWorkspaceIdForPrincipal.mockResolvedValue("ws-1");
    mockDb.insert.mockReturnValue(createChainMock([{ id: "new-uuid" }]) as never);
  });

  it("should_keep_the_desired_slug_unchanged_when_it_is_free", async () => {
    queueSelectResults([[]]); // desired slug: no conflict

    const result = await importNewInstance(makeBundle("free-agent"));

    expect(result.slug).toBe("free-agent");
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it("should_append_dash_imported_when_the_desired_slug_is_taken", async () => {
    queueSelectResults([
      [{ slug: "taken-agent" }], // desired: conflict
      [], // "-imported": free
    ]);

    const result = await importNewInstance(makeBundle("taken-agent"));

    expect(result.slug).toBe("taken-agent-imported");
    expect(mockDb.select).toHaveBeenCalledTimes(2);
  });

  it("should_append_dash_imported_2_when_both_the_desired_slug_and_dash_imported_are_taken", async () => {
    queueSelectResults([
      [{ slug: "taken-agent" }], // desired: conflict
      [{ slug: "taken-agent-imported" }], // "-imported": conflict
      [], // "-imported-2": free
    ]);

    const result = await importNewInstance(makeBundle("taken-agent"));

    expect(result.slug).toBe("taken-agent-imported-2");
    expect(mockDb.select).toHaveBeenCalledTimes(3);
  });

  it("should_throw_when_every_candidate_up_to_imported_100_is_taken", async () => {
    // Desired slug + all 100 "-imported"/"-imported-N" candidates conflict.
    mockDb.select.mockReturnValue(createChainMock([{ slug: "always-taken" }]) as never);

    await expect(importNewInstance(makeBundle("always-taken"))).rejects.toThrow(
      /Could not resolve unique slug for "always-taken"/,
    );
    // 1 probe for the desired slug + 100 for the numbered candidates.
    expect(mockDb.select).toHaveBeenCalledTimes(101);
    // The collision loop runs before the transaction opens — nothing is written.
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
});
