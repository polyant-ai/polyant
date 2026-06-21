// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for packages/engine/src/instances/resolve-agent-id.ts
 *
 * resolveAgentId(slug) → uuid | undefined
 * resolveAgentSlug(uuid) → slug | undefined
 *
 * These helpers are critical: 10 DB tables use `instance_id uuid` with FK,
 * but ToolContext.agentId is the slug. Mismatches return zero rows silently.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Chain mock helper (mirrors secrets.store.test.ts)
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
const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
  },
}));

vi.mock("../database/client.js", () => ({ db: mockDb }));

vi.mock("./schema.js", () => ({
  agents: {
    id: "id",
    slug: "slug",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ type: "eq", args })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
import {
  resolveAgentId,
  resolveAgentSlug,
} from "./resolve-agent-id.js";
import { asAgentSlug, asAgentUuid } from "./identifiers.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("resolveAgentId / resolveAgentSlug", () => {
  const SLUG = "default";
  const UUID = "00000000-0000-0000-0000-000000000001";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // resolveAgentId
  // -----------------------------------------------------------------------
  describe("resolveAgentId", () => {
    it("returns the uuid when slug matches an existing instance", async () => {
      mockDb.select.mockReturnValue(createChainMock([{ id: UUID }]) as never);

      const result = await resolveAgentId(asAgentSlug(SLUG));

      expect(result).toBe(UUID);
    });

    it("returns undefined when slug does not exist (never throws)", async () => {
      mockDb.select.mockReturnValue(createChainMock([]) as never);

      const result = await resolveAgentId(asAgentSlug("nonexistent-slug"));

      expect(result).toBeUndefined();
    });

    it("returns undefined for an empty-string slug (zero rows)", async () => {
      mockDb.select.mockReturnValue(createChainMock([]) as never);

      const result = await resolveAgentId(asAgentSlug(""));

      expect(result).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // resolveAgentSlug
  // -----------------------------------------------------------------------
  describe("resolveAgentSlug", () => {
    it("returns the slug when uuid matches an existing instance", async () => {
      mockDb.select.mockReturnValue(createChainMock([{ slug: SLUG }]) as never);

      const result = await resolveAgentSlug(asAgentUuid(UUID));

      expect(result).toBe(SLUG);
    });

    it("returns undefined when uuid does not exist (never throws)", async () => {
      mockDb.select.mockReturnValue(createChainMock([]) as never);

      const result = await resolveAgentSlug(asAgentUuid("00000000-0000-0000-0000-000000000099"));

      expect(result).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Round-trip
  // -----------------------------------------------------------------------
  describe("round-trip", () => {
    it("slug → uuid → slug returns the original slug", async () => {
      // First call: resolveAgentId returns UUID
      // Second call: resolveAgentSlug returns SLUG
      mockDb.select
        .mockReturnValueOnce(createChainMock([{ id: UUID }]) as never)
        .mockReturnValueOnce(createChainMock([{ slug: SLUG }]) as never);

      const uuid = await resolveAgentId(asAgentSlug(SLUG));
      expect(uuid).toBe(UUID);

      const slug = await resolveAgentSlug(uuid!);
      expect(slug).toBe(SLUG);
    });
  });
});
