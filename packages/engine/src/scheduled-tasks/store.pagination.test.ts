// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pagination tests for listByInstance.
 * Split into its own file because the chain-mock shape needed to assert on
 * .limit() / .offset() arguments is incompatible with the broader mock used
 * by store.test.ts. Each test file has its own vi.mock for ../database/client.js.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { asInstanceSlug } from "../instances/identifiers.js";

// Capture every drizzle builder method call so we can assert on the
// arguments passed to `.limit()` / `.offset()` and on whether `.where()`
// received a composite (enabledOnly) or a single-eq predicate.
const calls = {
  whereArg: undefined as unknown,
  limitArg: undefined as number | undefined,
  offsetArg: undefined as number | undefined,
};

vi.mock("../database/client.js", () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockImplementation((arg: unknown) => {
      calls.whereArg = arg;
      return chain;
    }),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockImplementation((arg: number) => {
      calls.limitArg = arg;
      return chain;
    }),
    offset: vi.fn().mockImplementation((arg: number) => {
      calls.offsetArg = arg;
      // Final terminal in the chain — the await happens here.
      return Promise.resolve([]);
    }),
  };
  return { db: chain };
});

import { listByInstance, LIST_BY_INSTANCE_DEFAULT_LIMIT } from "./store.js";

describe("scheduled-tasks store: listByInstance pagination", () => {
  beforeEach(() => {
    calls.whereArg = undefined;
    calls.limitArg = undefined;
    calls.offsetArg = undefined;
  });

  it("applies the default cap of 100 when called with only an instanceId (backward-compat)", async () => {
    await listByInstance(asInstanceSlug("any-slug"));
    expect(LIST_BY_INSTANCE_DEFAULT_LIMIT).toBe(100);
    expect(calls.limitArg).toBe(100);
    expect(calls.offsetArg).toBe(0);
  });

  it("respects an explicit limit option", async () => {
    await listByInstance(asInstanceSlug("any-slug"), { limit: 50 });
    expect(calls.limitArg).toBe(50);
    expect(calls.offsetArg).toBe(0);
  });

  it("respects an explicit offset option", async () => {
    await listByInstance(asInstanceSlug("any-slug"), { limit: 25, offset: 50 });
    expect(calls.limitArg).toBe(25);
    expect(calls.offsetArg).toBe(50);
  });

  it("falls back to the default cap when limit is undefined but offset is set", async () => {
    await listByInstance(asInstanceSlug("any-slug"), { offset: 200 });
    expect(calls.limitArg).toBe(100);
    expect(calls.offsetArg).toBe(200);
  });

  it("changes the where predicate when enabledOnly is true", async () => {
    await listByInstance(asInstanceSlug("any-slug"));
    const baseWhere = calls.whereArg;
    calls.whereArg = undefined;

    await listByInstance(asInstanceSlug("any-slug"), { enabledOnly: true });
    expect(calls.whereArg).not.toBe(baseWhere);
    expect(calls.whereArg).toBeDefined();
  });
});
