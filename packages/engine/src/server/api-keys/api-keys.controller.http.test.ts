// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Issuing and revoking management API keys, over real HTTP, through the real
 * guard chain (AuthGuard, then PermissionGuard backed by the real
 * AuthorizationService and OSS strategy). Only the leaves are stubbed: token
 * validation, the role-binding reads, the org-slug lookup, the key store and
 * the audit store.
 *
 * What this pins:
 *   - only an Owner (or a platform admin) of the ADDRESSED organization may
 *     list, issue or revoke; an Admin, an Owner of another organization and an
 *     unknown slug all get the same 403;
 *   - a management key is refused on issue and revoke even though it holds
 *     `org:write`, so a key can never mint or revoke keys; it may list the
 *     keys of its own organization only;
 *   - an issued key carries the Owner set, the body cannot narrow or widen it,
 *     and the listing never carries a hash;
 *   - issue and revoke each leave a management-audit row.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  validateSessionToken,
  validateManagementApiKey,
  listManagementApiKeys,
  createManagementApiKey,
  deleteManagementApiKey,
  resolveOrgIdBySlug,
  readPlatformAdminFlag,
  readUserBindings,
  recordAudit,
} = vi.hoisted(() => ({
  validateSessionToken: vi.fn(),
  validateManagementApiKey: vi.fn(),
  listManagementApiKeys: vi.fn(),
  createManagementApiKey: vi.fn(),
  deleteManagementApiKey: vi.fn(),
  resolveOrgIdBySlug: vi.fn(),
  readPlatformAdminFlag: vi.fn(),
  readUserBindings: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock("../../config.js", () => ({ config: { auth: { mode: "session" } } }));
vi.mock("../../database/client.js", () => ({ db: {}, queryClient: {} }));
vi.mock("../../auth/auth-user.service.js", () => ({ validateSessionToken }));
vi.mock("../../instances/secrets.store.js", () => ({ findInstanceByAuthApiKey: vi.fn() }));
vi.mock("../../auth/management-api-keys.store.js", () => ({
  validateManagementApiKey,
  listManagementApiKeys,
  createManagementApiKey,
  deleteManagementApiKey,
}));
vi.mock("../../organizations/members.store.js", () => ({ resolveOrgIdBySlug }));
vi.mock("../../authz/authz.store.js", () => ({
  readPlatformAdminFlag,
  readUserBindings,
  readAgentScope: vi.fn(),
  readWorkspaceId: vi.fn(),
}));
vi.mock("../../management-audit/management-audit.store.js", () => ({
  managementAuditStore: { record: recordAudit },
}));

import "reflect-metadata";
import { Module, type INestApplication } from "@nestjs/common";
import { APP_GUARD, NestFactory, Reflector } from "@nestjs/core";
import { AuthGuard } from "../../auth/auth.guard.js";
import { PermissionGuard } from "../../authz/permission.guard.js";
import { AuthorizationService } from "../../authz/authorization.service.js";
import { ENTITLEMENT_SERVICE } from "../../authz/entitlement.service.js";
import { bindingCache, platformAdminCache } from "../../authz/authz.caches.js";
import { SYSTEM_ROLE_PERMISSIONS } from "../../authz/permissions.js";
import { ApiKeysController } from "./api-keys.controller.js";
import { ApiKeysService } from "./api-keys.service.js";

@Module({
  controllers: [ApiKeysController],
  providers: [
    Reflector,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    AuthorizationService,
    { provide: ENTITLEMENT_SERVICE, useValue: { isAvailable: () => false } },
    ApiKeysService,
  ],
})
class ApiKeysTestModule {}

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const KEY_ID = "33333333-3333-4333-8333-333333333333";

/** Users, by id, and the org-scope role each holds in which organization. */
const ROLES: Record<string, { org: string; role: "owner" | "admin" }> = {
  owner: { org: ORG, role: "owner" },
  admin: { org: ORG, role: "admin" },
  "other-owner": { org: OTHER_ORG, role: "owner" },
};

let app: INestApplication;
let baseUrl: string;

async function call(
  method: string,
  path: string,
  { as, key, body }: { as?: string; key?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (as) headers.authorization = `Bearer ${as}`;
  if (key) headers["x-polyant-key"] = key;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: json };
}

const created = {
  id: KEY_ID,
  name: "ci",
  permissions: ["org:write"],
  expiresAt: null,
  lastUsedAt: null,
  createdAt: new Date("2026-10-12T10:00:00.000Z"),
};

beforeAll(async () => {
  app = await NestFactory.create(ApiKeysTestModule, { logger: false });
  await app.listen(0);
  baseUrl = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  bindingCache.clear();
  platformAdminCache.clear();
  // The bearer token IS the user id, so each test names its caller directly.
  validateSessionToken.mockImplementation(async (token: string) => ({
    userId: token,
    email: `${token}@example.test`,
    principalType: "user",
    orgId: ROLES[token]?.org,
  }));
  validateManagementApiKey.mockResolvedValue(null);
  readPlatformAdminFlag.mockImplementation(async (userId: string) => userId === "platform-admin");
  readUserBindings.mockImplementation(async (userId: string, organizationId: string) => {
    const grant = ROLES[userId];
    if (!grant || grant.org !== organizationId) return [];
    return [
      {
        scopeType: "organization",
        scopeId: grant.org,
        permissions: new Set(SYSTEM_ROLE_PERMISSIONS[grant.role]),
      },
    ];
  });
  resolveOrgIdBySlug.mockImplementation(async (slug: string) =>
    slug === "acme" ? ORG : slug === "other" ? OTHER_ORG : null,
  );
  listManagementApiKeys.mockResolvedValue([]);
  createManagementApiKey.mockResolvedValue({ key: created, token: `pk_${KEY_ID}_secret` });
  deleteManagementApiKey.mockResolvedValue(true);
});

describe("POST /api/organizations/:orgSlug/api-keys", () => {
  it("issues a key with the Owner permission set to an Owner and returns the token once", async () => {
    const res = await call("POST", "/api/organizations/acme/api-keys", {
      as: "owner",
      body: { name: "  ci  ", expiresAt: "2099-01-01T00:00:00.000Z" },
    });

    expect(res.status).toBe(201);
    expect(res.body.token).toBe(`pk_${KEY_ID}_secret`);
    expect(res.body.key).toEqual({
      id: KEY_ID,
      name: "ci",
      permissions: ["org:write"],
      expiresAt: null,
      lastUsedAt: null,
      createdAt: "2026-10-12T10:00:00.000Z",
    });

    const input = createManagementApiKey.mock.calls[0][0];
    expect(input.organizationId).toBe(ORG);
    expect(input.name).toBe("ci");
    expect(input.expiresAt).toEqual(new Date("2099-01-01T00:00:00.000Z"));
    // The Owner set: the destructive, governance and org-level permissions an
    // Admin or Member does not hold are all there.
    expect(input.permissions).toEqual(
      expect.arrayContaining(["org:write", "org.member:manage", "agent:delete", "agent:read"]),
    );
  });

  it("records who issued the key", async () => {
    await call("POST", "/api/organizations/acme/api-keys", { as: "owner", body: { name: "ci" } });

    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "api_key.create",
        actorUserId: "owner",
        actorEmail: "owner@example.test",
        targetType: "api_key",
        targetId: KEY_ID,
      }),
    );
  });

  it("lets a platform admin who holds no binding issue a key", async () => {
    const res = await call("POST", "/api/organizations/acme/api-keys", {
      as: "platform-admin",
      body: { name: "ci" },
    });
    expect(res.status).toBe(201);
  });

  it("refuses an Admin: issuing a key is org:write, which only an Owner holds", async () => {
    const res = await call("POST", "/api/organizations/acme/api-keys", { as: "admin", body: { name: "ci" } });
    expect(res.status).toBe(403);
    expect(createManagementApiKey).not.toHaveBeenCalled();
  });

  it("refuses an Owner of another organization addressing this one", async () => {
    const res = await call("POST", "/api/organizations/acme/api-keys", {
      as: "other-owner",
      body: { name: "ci" },
    });
    expect(res.status).toBe(403);
    expect(createManagementApiKey).not.toHaveBeenCalled();
  });

  it("answers an unknown organization with the same 403, revealing nothing", async () => {
    const res = await call("POST", "/api/organizations/ghost/api-keys", { as: "owner", body: { name: "ci" } });
    expect(res.status).toBe(403);
  });

  it("refuses a management key, though it holds org:write: a key cannot mint a key", async () => {
    validateManagementApiKey.mockResolvedValue({
      principalType: "service",
      orgId: ORG,
      permissions: new Set(SYSTEM_ROLE_PERMISSIONS.owner),
    });
    const res = await call("POST", "/api/organizations/acme/api-keys", {
      key: `pk_${KEY_ID}_secret`,
      body: { name: "successor" },
    });
    expect(res.status).toBe(403);
    // Refused because it is a key, not merely for lacking a binding: a key has
    // no user behind it, so it would also fail the binding check below, and
    // that accident must not be what keeps it out.
    expect(res.body.message).toMatch(/never with a key/);
    expect(createManagementApiKey).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it.each([
    ["a permission set", { name: "ci", permissions: ["agent:read"] }],
    ["no name", {}],
    ["a blank name", { name: "   " }],
    ["a past expiry", { name: "ci", expiresAt: "2001-01-01T00:00:00.000Z" }],
    ["an expiry that is not a date", { name: "ci", expiresAt: "next week" }],
    ["an unknown field", { name: "ci", scope: "all" }],
  ])("rejects %s with 400 and issues nothing", async (_label, body) => {
    const res = await call("POST", "/api/organizations/acme/api-keys", { as: "owner", body });
    expect(res.status).toBe(400);
    expect(createManagementApiKey).not.toHaveBeenCalled();
  });
});

describe("GET /api/organizations/:orgSlug/api-keys", () => {
  it("lists the organization's keys without their hash", async () => {
    listManagementApiKeys.mockResolvedValue([
      // A store that leaked a column must not leak it onto the wire.
      { ...created, lastUsedAt: new Date("2026-10-12T11:00:00.000Z"), keyHash: "sha256:abc" },
    ]);

    const res = await call("GET", "/api/organizations/acme/api-keys", { as: "owner" });

    expect(res.status).toBe(200);
    expect(listManagementApiKeys).toHaveBeenCalledWith(ORG);
    expect(res.body.keys).toEqual([
      {
        id: KEY_ID,
        name: "ci",
        permissions: ["org:write"],
        expiresAt: null,
        lastUsedAt: "2026-10-12T11:00:00.000Z",
        createdAt: "2026-10-12T10:00:00.000Z",
      },
    ]);
  });

  it("refuses an Admin", async () => {
    expect((await call("GET", "/api/organizations/acme/api-keys", { as: "admin" })).status).toBe(403);
    expect(listManagementApiKeys).not.toHaveBeenCalled();
  });

  // Listing reveals no secret, and a key is the only credential polyant-cli
  // holds, so `apikey list` has to work with one.
  it("lets a management key list the keys of its own organization", async () => {
    validateManagementApiKey.mockResolvedValue({
      principalType: "service",
      orgId: ORG,
      permissions: new Set(SYSTEM_ROLE_PERMISSIONS.owner),
    });
    const res = await call("GET", "/api/organizations/acme/api-keys", { key: "pk_x" });
    expect(res.status).toBe(200);
    expect(listManagementApiKeys).toHaveBeenCalledWith(ORG);
  });

  it("refuses a management key listing another organization's keys", async () => {
    validateManagementApiKey.mockResolvedValue({
      principalType: "service",
      orgId: ORG,
      permissions: new Set(SYSTEM_ROLE_PERMISSIONS.owner),
    });
    expect((await call("GET", "/api/organizations/other/api-keys", { key: "pk_x" })).status).toBe(403);
    expect((await call("GET", "/api/organizations/ghost/api-keys", { key: "pk_x" })).status).toBe(403);
    expect(listManagementApiKeys).not.toHaveBeenCalled();
  });

  it("refuses a management key that lacks org:write", async () => {
    validateManagementApiKey.mockResolvedValue({
      principalType: "service",
      orgId: ORG,
      permissions: new Set(["agent:read"]),
    });
    expect((await call("GET", "/api/organizations/acme/api-keys", { key: "pk_x" })).status).toBe(403);
    expect(listManagementApiKeys).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/organizations/:orgSlug/api-keys/:keyId", () => {
  it("revokes a key of the addressed organization and records it", async () => {
    const res = await call("DELETE", `/api/organizations/acme/api-keys/${KEY_ID}`, { as: "owner" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });
    expect(deleteManagementApiKey).toHaveBeenCalledWith(ORG, KEY_ID);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "api_key.delete", actorUserId: "owner", targetId: KEY_ID }),
    );
  });

  it("answers 404 when the organization has no such key, and records nothing", async () => {
    deleteManagementApiKey.mockResolvedValue(false);
    const res = await call("DELETE", `/api/organizations/acme/api-keys/${KEY_ID}`, { as: "owner" });
    expect(res.status).toBe(404);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("refuses a management key revoking any key, its own included", async () => {
    validateManagementApiKey.mockResolvedValue({
      principalType: "service",
      orgId: ORG,
      permissions: new Set(SYSTEM_ROLE_PERMISSIONS.owner),
    });
    const res = await call("DELETE", `/api/organizations/acme/api-keys/${KEY_ID}`, {
      key: `pk_${KEY_ID}_secret`,
    });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/never with a key/);
    expect(deleteManagementApiKey).not.toHaveBeenCalled();
  });

  it("refuses an Owner of another organization", async () => {
    const res = await call("DELETE", `/api/organizations/acme/api-keys/${KEY_ID}`, { as: "other-owner" });
    expect(res.status).toBe(403);
    expect(deleteManagementApiKey).not.toHaveBeenCalled();
  });
});
