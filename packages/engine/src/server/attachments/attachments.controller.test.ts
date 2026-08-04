// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for AttachmentsController — the cross-org IDOR gate (issue #133).
 *
 * The route param is `key`, not `slug`, so PermissionGuard derives no agent
 * scope: the handler itself must prove the agent slug embedded in the S3 key
 * belongs to the caller's organization BEFORE opening the object stream. Every
 * denial must be a 404, and must never reach S3.
 */

import "reflect-metadata";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import type { Response } from "express";

const {
  mockGetAttachmentStream,
  mockIsConfigured,
  mockResolvePrincipalOrgId,
  mockReadAgentScope,
} = vi.hoisted(() => ({
  mockGetAttachmentStream: vi.fn(),
  mockIsConfigured: vi.fn(() => true),
  mockResolvePrincipalOrgId: vi.fn(),
  mockReadAgentScope: vi.fn(),
}));

vi.mock("../../attachments/platform-storage.js", () => ({
  getAttachmentStream: mockGetAttachmentStream,
  isPlatformStorageConfigured: mockIsConfigured,
}));

// The org-resolution rule is shared with the agent create/list paths (and unit
// tested there); stub it so this file never reaches a database.
vi.mock("../../instances/store.js", () => ({
  resolvePrincipalOrgId: mockResolvePrincipalOrgId,
}));

// The tenancy check now lives in the shared `callerMayAccessAgent`, which reads
// the agent scope directly. Stubbing the store (rather than the helper) keeps the
// REAL decision logic under test here — mocking the helper would leave this file
// asserting its own mock.
vi.mock("../../authz/authz.store.js", () => ({
  readAgentScope: mockReadAgentScope,
}));

import { AttachmentsController } from "./attachments.controller.js";

const ORG_A = "org-a";
const ORG_B = "org-b";
const KEY_A = "attachments/agent-a/agent-a:web:c1/photo.png";

/** Minimal Express response double: only the members the handler touches. */
function makeRes() {
  return {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    send: vi.fn(),
    end: vi.fn(),
    headersSent: false,
  } as unknown as Response;
}

/** A no-op readable stream double, enough for the pipe path. */
function makeStream() {
  return { on: vi.fn().mockReturnThis(), pipe: vi.fn() };
}

function makeController(scopeOrg: string | null) {
  mockReadAgentScope.mockResolvedValue(
    scopeOrg === null
      ? null
      : { agentId: "id-1", workspaceId: "ws-1", organizationId: scopeOrg },
  );
  return { controller: new AttachmentsController(), resolveAgentScope: mockReadAgentScope };
}

describe("AttachmentsController.getAttachment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsConfigured.mockReturnValue(true);
    // Default: the claim on the principal is authoritative.
    mockResolvePrincipalOrgId.mockImplementation(async (orgId?: string) => orgId ?? null);
    mockGetAttachmentStream.mockResolvedValue({
      body: makeStream(),
      contentType: "image/png",
      contentLength: 12,
    });
  });

  it("should return 404 and never open the stream when the agent belongs to another org", async () => {
    // The key names an agent of org B; the caller is authenticated in org A.
    const { controller } = makeController(ORG_B);

    await expect(
      controller.getAttachment(KEY_A, makeRes(), { orgId: ORG_A }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(mockGetAttachmentStream).not.toHaveBeenCalled();
  });

  it("should stream the attachment when the caller is in the owning org", async () => {
    const { controller, resolveAgentScope } = makeController(ORG_A);
    const res = makeRes();

    await controller.getAttachment(KEY_A, res, { orgId: ORG_A });

    expect(resolveAgentScope).toHaveBeenCalledWith("agent-a");
    expect(mockGetAttachmentStream).toHaveBeenCalledWith(KEY_A);
    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "image/png");
  });

  it("should return 404 when the agent slug does not resolve to any scope", async () => {
    const { controller } = makeController(null);

    await expect(
      controller.getAttachment(KEY_A, makeRes(), { orgId: ORG_A }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(mockGetAttachmentStream).not.toHaveBeenCalled();
  });

  it("should return 404 when the caller has no resolvable org (fail closed)", async () => {
    // Multi-org deployment, principal without an org claim → unprovable.
    mockResolvePrincipalOrgId.mockResolvedValue(null);
    const { controller, resolveAgentScope } = makeController(ORG_A);

    await expect(
      controller.getAttachment(KEY_A, makeRes(), {}),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(resolveAgentScope).not.toHaveBeenCalled();
    expect(mockGetAttachmentStream).not.toHaveBeenCalled();
  });

  it("should serve a claimless principal on a single-org deployment", async () => {
    // ALB-OIDC identities and pre-RBAC JWTs carry no orgId. Hard-failing them
    // would break attachment download outright on a single-tenant install, so
    // the shared resolver falls back to the deployment's only organization.
    mockResolvePrincipalOrgId.mockResolvedValue(ORG_A);
    const { controller } = makeController(ORG_A);

    await controller.getAttachment(KEY_A, makeRes(), {});

    expect(mockGetAttachmentStream).toHaveBeenCalledWith(KEY_A);
  });

  it("should return 404 when the agent scope lookup throws (fail closed)", async () => {
    const { controller, resolveAgentScope } = makeController(ORG_A);
    resolveAgentScope.mockRejectedValue(new Error("db down"));

    await expect(
      controller.getAttachment(KEY_A, makeRes(), { orgId: ORG_A }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(mockGetAttachmentStream).not.toHaveBeenCalled();
  });

  describe("per-instance API-key principal", () => {
    it("should stream when the key belongs to the requesting instance", async () => {
      const { controller, resolveAgentScope } = makeController(ORG_A);

      await controller.getAttachment(KEY_A, makeRes(), {
        kind: "instance",
        instanceSlug: "agent-a",
      });

      // Decided on the slug alone — an instance principal carries no org.
      expect(resolveAgentScope).not.toHaveBeenCalled();
      expect(mockGetAttachmentStream).toHaveBeenCalledWith(KEY_A);
    });

    it("should return 404 when the key belongs to a different instance", async () => {
      const { controller } = makeController(ORG_A);

      await expect(
        controller.getAttachment(KEY_A, makeRes(), {
          kind: "instance",
          instanceSlug: "agent-b",
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(mockGetAttachmentStream).not.toHaveBeenCalled();
    });
  });

  describe("pre-existing key validation (unchanged)", () => {
    it("should return 404 when the key contains a path traversal segment", async () => {
      const { controller, resolveAgentScope } = makeController(ORG_A);

      await expect(
        controller.getAttachment(
          "attachments/agent-a/../other/photo.png",
          makeRes(),
          { orgId: ORG_A },
        ),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(resolveAgentScope).not.toHaveBeenCalled();
      expect(mockGetAttachmentStream).not.toHaveBeenCalled();
    });

    it("should return 404 when the key does not match the expected shape", async () => {
      const { controller } = makeController(ORG_A);

      for (const key of ["photo.png", "attachments/agent-a/photo.png", "other/a/b/c.png"]) {
        await expect(
          controller.getAttachment(key, makeRes(), { orgId: ORG_A }),
        ).rejects.toBeInstanceOf(NotFoundException);
      }
      expect(mockGetAttachmentStream).not.toHaveBeenCalled();
    });

    it("should return 404 when platform storage is not configured", async () => {
      mockIsConfigured.mockReturnValue(false);
      const { controller } = makeController(ORG_A);

      await expect(
        controller.getAttachment(KEY_A, makeRes(), { orgId: ORG_A }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(mockGetAttachmentStream).not.toHaveBeenCalled();
    });
  });
});
