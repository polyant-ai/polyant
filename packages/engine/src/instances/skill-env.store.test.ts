// SPDX-License-Identifier: AGPL-3.0-or-later

import { PgDialect } from "drizzle-orm/pg-core";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks (vi.mock factories are hoisted above imports) ──────────────

const {
  selectMock,
  fromMock,
  whereMock,
  insertMock,
  valuesMock,
  onConflictDoUpdateMock,
  deleteMock,
  deleteWhereMock,
  encryptMock,
  decryptMock,
} = vi.hoisted(() => {
  const whereMock = vi.fn();
  const fromMock = vi.fn().mockReturnValue({ where: whereMock });
  const selectMock = vi.fn().mockReturnValue({ from: fromMock });

  const onConflictDoUpdateMock = vi.fn().mockResolvedValue(undefined);
  const valuesMock = vi.fn().mockReturnValue({ onConflictDoUpdate: onConflictDoUpdateMock });
  const insertMock = vi.fn().mockReturnValue({ values: valuesMock });

  const deleteWhereMock = vi.fn().mockResolvedValue(undefined);
  const deleteMock = vi.fn().mockReturnValue({ where: deleteWhereMock });

  const encryptMock = vi.fn((v: string) => `encrypted:${v}`);
  const decryptMock = vi.fn((v: string) => v.replace("encrypted:", ""));

  return {
    selectMock,
    fromMock,
    whereMock,
    insertMock,
    valuesMock,
    onConflictDoUpdateMock,
    deleteMock,
    deleteWhereMock,
    encryptMock,
    decryptMock,
  };
});

vi.mock("../database/client.js", () => ({
  db: {
    select: selectMock,
    insert: insertMock,
    delete: deleteMock,
  },
}));

vi.mock("../crypto/index.js", () => ({
  encrypt: encryptMock,
  decrypt: decryptMock,
}));

import { setSkillEnv, getSkillEnv, hasAllRequiredEnv, deleteSkillEnv } from "./skill-env.store.js";
import { asInstanceSlug, asInstanceUuid } from "./identifiers.js";

/** Create a thenable query-builder mock that supports .limit() */
function thenable(rows: unknown[]) {
  const p = Promise.resolve(rows);
  return Object.assign(p, { limit: vi.fn().mockReturnValue(Promise.resolve(rows)) });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("skill-env.store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default return values after clearAllMocks
    whereMock.mockReturnValue(thenable([]));
    fromMock.mockReturnValue({ where: whereMock });
    selectMock.mockReturnValue({ from: fromMock });
    valuesMock.mockReturnValue({ onConflictDoUpdate: onConflictDoUpdateMock });
    insertMock.mockReturnValue({ values: valuesMock });
    deleteMock.mockReturnValue({ where: deleteWhereMock });
    onConflictDoUpdateMock.mockResolvedValue(undefined);
    deleteWhereMock.mockResolvedValue(undefined);
    encryptMock.mockImplementation((v: string) => `encrypted:${v}`);
    decryptMock.mockImplementation((v: string) => v.replace("encrypted:", ""));
  });

  // ── setSkillEnv ──────────────────────────────────────────────────────────

  describe("setSkillEnv", () => {
    it("encrypts sensitive values before storing", async () => {
      await setSkillEnv({
        instanceId: asInstanceUuid("inst-1"),
        skillSlug: "weather",
        key: "API_KEY",
        value: "secret-123",
        sensitive: true,
      });

      expect(encryptMock).toHaveBeenCalledWith("secret-123");
      expect(valuesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId: "inst-1",
          skillSlug: "weather",
          key: "API_KEY",
          value: "encrypted:secret-123",
          encrypted: true,
        }),
      );
      expect(onConflictDoUpdateMock).toHaveBeenCalled();
    });

    it("stores plaintext for non-sensitive values", async () => {
      await setSkillEnv({
        instanceId: asInstanceUuid("inst-1"),
        skillSlug: "weather",
        key: "BASE_URL",
        value: "https://api.example.com",
        sensitive: false,
      });

      expect(encryptMock).not.toHaveBeenCalled();
      expect(valuesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          value: "https://api.example.com",
          encrypted: false,
        }),
      );
    });
  });

  // ── getSkillEnv ──────────────────────────────────────────────────────────

  describe("getSkillEnv", () => {
    it("decrypts encrypted rows and returns plaintext rows as-is", async () => {
      // First call: resolveInstanceId → returns UUID
      whereMock.mockReturnValueOnce(thenable([{ id: "uuid-123" }]));
      // Second call: main env query
      whereMock.mockReturnValueOnce(thenable([
        { key: "API_KEY", value: "encrypted:secret-123", encrypted: true },
        { key: "BASE_URL", value: "https://api.example.com", encrypted: false },
      ]));

      const result = await getSkillEnv(asInstanceSlug("inst-1"), "weather");

      expect(decryptMock).toHaveBeenCalledWith("encrypted:secret-123");
      expect(decryptMock).not.toHaveBeenCalledWith("https://api.example.com");
      expect(result).toEqual({
        API_KEY: "secret-123",
        BASE_URL: "https://api.example.com",
      });
    });

    it("returns empty object when instance not found", async () => {
      // resolveInstanceId returns no rows → undefined → early return {}
      whereMock.mockReturnValueOnce(thenable([]));

      const result = await getSkillEnv(asInstanceSlug("inst-1"), "weather");

      expect(result).toEqual({});
    });

    it("returns empty object when no env rows exist", async () => {
      whereMock.mockReturnValueOnce(thenable([{ id: "uuid-123" }]));
      whereMock.mockReturnValueOnce(thenable([]));

      const result = await getSkillEnv(asInstanceSlug("inst-1"), "weather");

      expect(result).toEqual({});
    });
  });

  // ── hasAllRequiredEnv ────────────────────────────────────────────────────

  describe("hasAllRequiredEnv", () => {
    it("returns true when all required keys exist", async () => {
      whereMock.mockReturnValueOnce(thenable([{ id: "uuid-123" }]));
      whereMock.mockReturnValueOnce(thenable([{ key: "API_KEY" }, { key: "SECRET" }]));

      const result = await hasAllRequiredEnv(asInstanceSlug("inst-1"), "weather", ["API_KEY", "SECRET"]);

      expect(result).toBe(true);
    });

    it("returns false when some keys are missing", async () => {
      whereMock.mockReturnValueOnce(thenable([{ id: "uuid-123" }]));
      whereMock.mockReturnValueOnce(thenable([{ key: "API_KEY" }]));

      const result = await hasAllRequiredEnv(asInstanceSlug("inst-1"), "weather", ["API_KEY", "SECRET"]);

      expect(result).toBe(false);
    });

    it("returns false when instance not found", async () => {
      whereMock.mockReturnValueOnce(thenable([]));

      const result = await hasAllRequiredEnv(asInstanceSlug("inst-1"), "weather", ["API_KEY"]);

      expect(result).toBe(false);
    });

    it("returns true for empty keys array without querying DB", async () => {
      const result = await hasAllRequiredEnv(asInstanceSlug("inst-1"), "weather", []);

      expect(result).toBe(true);
      expect(selectMock).not.toHaveBeenCalled();
    });
  });

  // ── deleteSkillEnv ───────────────────────────────────────────────────────

  describe("deleteSkillEnv", () => {
    it("deletes scoped to instance AND skill AND key", async () => {
      await deleteSkillEnv(asInstanceUuid("inst-1"), "weather", "API_KEY");

      /*
        This file does not mock drizzle, so render the real SQL instead of
        inspecting a mock's shape — the strongest form available and the one
        `authz/scope-filter.test.ts` uses.

        The old assertion was `expect(deleteWhereMock).toHaveBeenCalled()` under
        the title "calls db.delete with correct where clause", and it never read
        the arguments. Losing the key predicate deletes every env var of that
        skill; losing the instance one reaches every tenant's copy.
      */
      expect(deleteMock).toHaveBeenCalled();
      const { sql: text, params } = new PgDialect().sqlToQuery(
        deleteWhereMock.mock.calls[0][0],
      );
      expect(text.match(/=/g)).toHaveLength(3);
      expect(text).toContain("instance_id");
      expect(text).toContain("skill_slug");
      expect(text).toContain("key");
      expect(params).toEqual(["inst-1", "weather", "API_KEY"]);
    });
  });
});
