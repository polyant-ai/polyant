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

import { createHash } from "node:crypto";
import {
  hashManagementApiKeySecret,
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

  // The id is a uuid column. Any other value made Postgres raise a cast error,
  // logged at error level, on every anonymous request that sent one.
  it("returns null when the id is not a uuid", () => {
    expect(parseManagementApiKeyToken("pk_x_y")).toBeNull();
    expect(parseManagementApiKeyToken("pk_1111-2222_secret")).toBeNull();
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

// bcrypt at cost 12 takes about 250 ms of event-loop time, and it ran on every
// request a management key authenticated. The secret is 32 random bytes, which
// a slow hash adds nothing to, so a SHA-256 digest is stored instead.
describe("validateManagementApiKey — key hash", () => {
  const sha256Of = (secret: string) => `sha256:${createHash("sha256").update(secret).digest("hex")}`;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hashes a secret as a SHA-256 digest", () => {
    expect(hashManagementApiKeySecret("s3cret")).toBe(sha256Of("s3cret"));
  });

  it("accepts a key stored as a SHA-256 digest without running bcrypt", async () => {
    mockSelectRows.mockResolvedValue([row({ keyHash: sha256Of("s3cret") })]);
    wireUpdateChain();

    const result = await validateManagementApiKey(`pk_${VALID_ID}_s3cret`);

    expect(result?.orgId).toBe("org-1");
    expect(mockVerifyPassword).not.toHaveBeenCalled();
  });

  it("refuses a wrong secret against a SHA-256 digest", async () => {
    mockSelectRows.mockResolvedValue([row({ keyHash: sha256Of("s3cret") })]);

    expect(await validateManagementApiKey(`pk_${VALID_ID}_other`)).toBeNull();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("stores the SHA-256 digest of a bcrypt key the first time it verifies", async () => {
    mockSelectRows.mockResolvedValue([row()]);
    mockVerifyPassword.mockResolvedValue(true);
    const { set } = wireUpdateChain();

    await validateManagementApiKey(`pk_${VALID_ID}_s3cret`);

    expect(set).toHaveBeenCalledWith(expect.objectContaining({ keyHash: sha256Of("s3cret") }));
  });

  it("leaves a bcrypt key alone when the secret does not match", async () => {
    mockSelectRows.mockResolvedValue([row()]);
    mockVerifyPassword.mockResolvedValue(false);

    await validateManagementApiKey(`pk_${VALID_ID}_wrong`);

    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
