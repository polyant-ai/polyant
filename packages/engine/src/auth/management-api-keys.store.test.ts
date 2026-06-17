// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for management-api-keys.store.ts (RBAC Stream 5).
 *
 * The store turns an `X-Polyant-Key` token (`pk_<id>_<secret>`) into a service
 * principal. It MUST:
 *   - reject malformed tokens without touching the DB,
 *   - reject when no row matches the id (→ null → 401 upstream),
 *   - reject when the bcrypt secret does not match,
 *   - reject an expired key,
 *   - on success return { orgId, permissions:Set } and refresh last_used_at.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSelectRows, mockUpdate, mockVerifyPassword } = vi.hoisted(() => ({
  mockSelectRows: vi.fn(),
  mockUpdate: vi.fn(),
  mockVerifyPassword: vi.fn(),
}));

vi.mock("../database/client.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => mockSelectRows(),
        }),
      }),
    }),
    update: mockUpdate,
  },
}));

vi.mock("../users/password.util.js", () => ({
  verifyPassword: mockVerifyPassword,
}));

import {
  parseManagementApiKeyToken,
  validateManagementApiKey,
} from "./management-api-keys.store.js";

const VALID_ID = "11111111-1111-1111-1111-111111111111";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: VALID_ID,
    organizationId: "org-1",
    keyHash: "$2a$12$hashedsecret",
    permissions: ["agent:read", "agent:write"],
    expiresAt: null,
    ...overrides,
  };
}

function wireUpdateChain() {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  mockUpdate.mockReturnValue({ set });
  return { set, where };
}

describe("parseManagementApiKeyToken", () => {
  it("parses pk_<id>_<secret> into id and secret", () => {
    const parsed = parseManagementApiKeyToken(`pk_${VALID_ID}_super-secret`);
    expect(parsed).toEqual({ id: VALID_ID, secret: "super-secret" });
  });

  it("returns null for a token without the pk_ prefix", () => {
    expect(parseManagementApiKeyToken(`${VALID_ID}_secret`)).toBeNull();
  });

  it("returns null when the secret segment is missing", () => {
    expect(parseManagementApiKeyToken(`pk_${VALID_ID}`)).toBeNull();
  });

  it("returns null for an empty token", () => {
    expect(parseManagementApiKeyToken("")).toBeNull();
  });
});

describe("validateManagementApiKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null for a malformed token without querying the DB", async () => {
    const result = await validateManagementApiKey("not-a-valid-token");
    expect(result).toBeNull();
    expect(mockSelectRows).not.toHaveBeenCalled();
  });

  it("returns null when no row matches the id", async () => {
    mockSelectRows.mockResolvedValue([]);
    const result = await validateManagementApiKey(`pk_${VALID_ID}_secret`);
    expect(result).toBeNull();
  });

  it("returns null when the bcrypt secret does not match", async () => {
    mockSelectRows.mockResolvedValue([row()]);
    mockVerifyPassword.mockResolvedValue(false);
    const result = await validateManagementApiKey(`pk_${VALID_ID}_wrong`);
    expect(result).toBeNull();
  });

  it("returns null when the key is expired", async () => {
    const past = new Date(Date.now() - 60_000);
    mockSelectRows.mockResolvedValue([row({ expiresAt: past })]);
    mockVerifyPassword.mockResolvedValue(true);
    const result = await validateManagementApiKey(`pk_${VALID_ID}_secret`);
    expect(result).toBeNull();
  });

  it("returns a service principal with orgId and a permission set on success", async () => {
    mockSelectRows.mockResolvedValue([row()]);
    mockVerifyPassword.mockResolvedValue(true);
    wireUpdateChain();

    const result = await validateManagementApiKey(`pk_${VALID_ID}_secret`);

    expect(result).not.toBeNull();
    expect(result?.principalType).toBe("service");
    expect(result?.orgId).toBe("org-1");
    expect(result?.permissions.has("agent:read")).toBe(true);
    expect(result?.permissions.has("agent:write")).toBe(true);
    expect(result?.permissions.has("agent:delete")).toBe(false);
  });

  it("honours a future expiry (not expired)", async () => {
    const future = new Date(Date.now() + 60_000);
    mockSelectRows.mockResolvedValue([row({ expiresAt: future })]);
    mockVerifyPassword.mockResolvedValue(true);
    wireUpdateChain();

    const result = await validateManagementApiKey(`pk_${VALID_ID}_secret`);
    expect(result).not.toBeNull();
  });

  it("refreshes last_used_at on a successful validation", async () => {
    mockSelectRows.mockResolvedValue([row()]);
    mockVerifyPassword.mockResolvedValue(true);
    const { set } = wireUpdateChain();

    await validateManagementApiKey(`pk_${VALID_ID}_secret`);

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ lastUsedAt: expect.any(Date) }),
    );
  });
});
