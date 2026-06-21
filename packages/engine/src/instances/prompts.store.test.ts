// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for seedInstancePrompts (#95 follow-up).
//
// seedInstancePrompts relies on the DB unique constraint
// (agentId, sectionKey) and an ON CONFLICT DO NOTHING clause to stay
// idempotent under concurrent seeding.  Verifying that contract at the
// DB level would require a live PostgreSQL; here we pin the behaviour at
// the ORM-call level — the store MUST NOT pre-query for existence, and
// MUST emit an atomic insert with onConflictDoNothing.

const { mockInsert, mockInvalidateCache } = vi.hoisted(() => ({
  mockInsert: vi.fn(),
  mockInvalidateCache: vi.fn(),
}));

vi.mock("../database/client.js", () => ({
  db: {
    insert: mockInsert,
  },
}));

vi.mock("../utils/ttl-cache.js", () => ({
  TtlCache: class {
    get() { return undefined; }
    set() { /* noop */ }
    delete(key: string) { mockInvalidateCache(key); }
  },
}));

import { seedInstancePrompts } from "./prompts.store.js";
import { DEFAULT_PROMPTS } from "./defaults.js";
import { asAgentUuid } from "./identifiers.js";

describe("seedInstancePrompts (#95)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits a single atomic insert with onConflictDoNothing", async () => {
    const onConflictSpy = vi.fn().mockResolvedValue(undefined);
    const valuesSpy = vi.fn().mockReturnValue({ onConflictDoNothing: onConflictSpy });
    mockInsert.mockReturnValue({ values: valuesSpy });

    await seedInstancePrompts(asAgentUuid("inst-1"));

    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(valuesSpy).toHaveBeenCalledTimes(1);
    const valuesArg = valuesSpy.mock.calls[0][0];
    expect(valuesArg).toHaveLength(DEFAULT_PROMPTS.length);
    expect(valuesArg[0]).toMatchObject({ agentId: "inst-1", sectionKey: expect.any(String) });

    // Critical: onConflictDoNothing must be used — a plain .values() would
    // raise on duplicate keys, re-opening the TOCTOU that #95 closed.
    expect(onConflictSpy).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: second call hits the same path (not a pre-select + insert)", async () => {
    const onConflictSpy = vi.fn().mockResolvedValue(undefined);
    const valuesSpy = vi.fn().mockReturnValue({ onConflictDoNothing: onConflictSpy });
    mockInsert.mockReturnValue({ values: valuesSpy });

    await seedInstancePrompts(asAgentUuid("inst-2"));
    await seedInstancePrompts(asAgentUuid("inst-2"));

    expect(mockInsert).toHaveBeenCalledTimes(2);
    expect(onConflictSpy).toHaveBeenCalledTimes(2);
    // No select/count calls were made — the DB unique constraint is the
    // only synchronization point (no count+insert TOCTOU).
  });

  it("invalidates the prompts cache after seeding", async () => {
    mockInsert.mockReturnValue({
      values: () => ({ onConflictDoNothing: () => Promise.resolve(undefined) }),
    });

    await seedInstancePrompts(asAgentUuid("inst-3"));

    expect(mockInvalidateCache).toHaveBeenCalledWith(asAgentUuid("inst-3"));
  });
});
