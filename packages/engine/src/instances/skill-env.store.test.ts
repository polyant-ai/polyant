// SPDX-License-Identifier: AGPL-3.0-or-later

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
import { asAgentSlug, asAgentUuid } from "./identifiers.js";

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
        agentId: asAgentUuid("inst-1"),
        skillSlug: "weather",
        key: "API_KEY",
        value: "secret-123",
        sensitive: true,
      });

      expect(encryptMock).toHaveBeenCalledWith("secret-123");
      expect(valuesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "inst-1",
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
        agentId: asAgentUuid("inst-1"),
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
      // First call: resolveAgentId → returns UUID
      whereMock.mockReturnValueOnce(thenable([{ id: "uuid-123" }]));
      // Second call: main env query
      whereMock.mockReturnValueOnce(thenable([
        { key: "API_KEY", value: "encrypted:secret-123", encrypted: true },
        { key: "BASE_URL", value: "https://api.example.com", encrypted: false },
      ]));

      const result = await getSkillEnv(asAgentSlug("inst-1"), "weather");

      expect(decryptMock).toHaveBeenCalledWith("encrypted:secret-123");
      expect(decryptMock).not.toHaveBeenCalledWith("https://api.example.com");
      expect(result).toEqual({
        API_KEY: "secret-123",
        BASE_URL: "https://api.example.com",
      });
    });

    it("returns empty object when instance not found", async () => {
      // resolveAgentId returns no rows → undefined → early return {}
      whereMock.mockReturnValueOnce(thenable([]));

      const result = await getSkillEnv(asAgentSlug("inst-1"), "weather");

      expect(result).toEqual({});
    });

    it("returns empty object when no env rows exist", async () => {
      whereMock.mockReturnValueOnce(thenable([{ id: "uuid-123" }]));
      whereMock.mockReturnValueOnce(thenable([]));

      const result = await getSkillEnv(asAgentSlug("inst-1"), "weather");

      expect(result).toEqual({});
    });
  });

  // ── hasAllRequiredEnv ────────────────────────────────────────────────────

  describe("hasAllRequiredEnv", () => {
    it("returns true when all required keys exist", async () => {
      whereMock.mockReturnValueOnce(thenable([{ id: "uuid-123" }]));
      whereMock.mockReturnValueOnce(thenable([{ key: "API_KEY" }, { key: "SECRET" }]));

      const result = await hasAllRequiredEnv(asAgentSlug("inst-1"), "weather", ["API_KEY", "SECRET"]);

      expect(result).toBe(true);
    });

    it("returns false when some keys are missing", async () => {
      whereMock.mockReturnValueOnce(thenable([{ id: "uuid-123" }]));
      whereMock.mockReturnValueOnce(thenable([{ key: "API_KEY" }]));

      const result = await hasAllRequiredEnv(asAgentSlug("inst-1"), "weather", ["API_KEY", "SECRET"]);

      expect(result).toBe(false);
    });

    it("returns false when instance not found", async () => {
      whereMock.mockReturnValueOnce(thenable([]));

      const result = await hasAllRequiredEnv(asAgentSlug("inst-1"), "weather", ["API_KEY"]);

      expect(result).toBe(false);
    });

    it("returns true for empty keys array without querying DB", async () => {
      const result = await hasAllRequiredEnv(asAgentSlug("inst-1"), "weather", []);

      expect(result).toBe(true);
      expect(selectMock).not.toHaveBeenCalled();
    });
  });

  // ── deleteSkillEnv ───────────────────────────────────────────────────────

  describe("deleteSkillEnv", () => {
    it("calls db.delete with correct where clause", async () => {
      await deleteSkillEnv(asAgentUuid("inst-1"), "weather", "API_KEY");

      expect(deleteMock).toHaveBeenCalled();
      expect(deleteWhereMock).toHaveBeenCalled();
    });
  });
});
