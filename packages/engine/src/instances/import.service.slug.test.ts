// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The slug and name a new agent is imported under: the ones the person
 * confirmed, refused when the slug is taken or malformed, never rewritten.
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

import { ImportSlugTakenError, importNewInstance } from "./import.service.js";

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

/** A unique violation as postgres-js surfaces it through drizzle: the code on `cause`. */
function uniqueViolation(): Error {
  return Object.assign(new Error("insert failed"), { cause: { code: "23505" } });
}

/** The insert chain, ending in the `returning()` the import awaits. */
function insertReturning(result: Promise<unknown>) {
  const values = vi.fn(() => ({ returning: () => result }));
  return { values };
}

describe("importNewInstance slug and name", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.transaction.mockImplementation(
      async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb),
    );
    mockResolveWorkspaceIdForPrincipal.mockResolvedValue("ws-1");
    mockDb.select.mockReturnValue(createChainMock([]) as never);
    mockDb.insert.mockReturnValue(createChainMock([{ id: "new-uuid" }]) as never);
  });

  it("creates the agent under the confirmed slug and trimmed name", async () => {
    const insert = insertReturning(Promise.resolve([{ id: "new-uuid" }]));
    mockDb.insert.mockReturnValueOnce(insert as never);
    const bundle = makeBundle("chosen-slug");
    bundle.instance.name = "  Chosen name  ";

    const result = await importNewInstance(bundle);

    expect(result.slug).toBe("chosen-slug");
    expect(insert.values).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "chosen-slug", name: "Chosen name" }),
    );
  });

  it("refuses a slug another agent already uses, without renaming it", async () => {
    mockDb.insert.mockReturnValueOnce(insertReturning(Promise.reject(uniqueViolation())) as never);

    const attempt = importNewInstance(makeBundle("taken-agent"));

    await expect(attempt).rejects.toBeInstanceOf(ImportSlugTakenError);
    await expect(attempt).rejects.toThrow('Slug "taken-agent" already exists');
  });

  it("passes any other insert failure through unchanged", async () => {
    const failure = new Error("connection lost");
    mockDb.insert.mockReturnValueOnce(insertReturning(Promise.reject(failure)) as never);

    await expect(importNewInstance(makeBundle("free-agent"))).rejects.toBe(failure);
  });

  it.each(["Bad Slug", "-leading", "trailing-", "a/b", "", "x".repeat(101)])(
    "refuses the malformed slug %j before writing anything",
    async (slug) => {
      await expect(importNewInstance(makeBundle(slug))).rejects.toThrow(/Invalid slug/);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    },
  );

  it("refuses an empty name before writing anything", async () => {
    const bundle = makeBundle("free-agent");
    bundle.instance.name = "   ";

    await expect(importNewInstance(bundle)).rejects.toThrow(/name cannot be empty/);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});
