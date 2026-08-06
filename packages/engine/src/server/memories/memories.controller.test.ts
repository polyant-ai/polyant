// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";

const mockResolveEmbeddingContext = vi.fn();
const mockEmbedMany = vi.fn();
const { mockResolvePrincipalOrgId, mockReadAgentScope } = vi.hoisted(() => ({
  mockResolvePrincipalOrgId: vi.fn(),
  mockReadAgentScope: vi.fn(),
}));

vi.mock("../../embeddings-gateway/index.js", () => ({
  resolveEmbeddingContext: (...args: unknown[]) => mockResolveEmbeddingContext(...args),
  embedMany: (...args: unknown[]) => mockEmbedMany(...args),
}));
vi.mock("../../memory/memory-store.js", () => ({
  searchMemories: vi.fn(),
  deleteAllMemories: vi.fn(),
  upsertMemory: vi.fn(),
  deleteMemoryForInstance: vi.fn(),
}));
vi.mock("../../instances/store.js", () => ({
  resolvePrincipalOrgId: mockResolvePrincipalOrgId,
}));
// Stub the STORE, not `callerMayAccessAgent` — the real tenancy decision stays
// under test. Mocking the helper would leave this file asserting its own mock.
vi.mock("../../authz/authz.store.js", () => ({
  readAgentScope: mockReadAgentScope,
}));

import { MemoriesController } from "./memories.controller.js";
import {
  upsertMemory,
  searchMemories,
  deleteMemoryForInstance,
} from "../../memory/memory-store.js";
import { asAgentSlug } from "../../instances/identifiers.js";
import type { AuthenticatedUser } from "../../auth/auth.types.js";

const ORG_A = "org-a";
const ORG_B = "org-b";

const callerOfOrgA: AuthenticatedUser = {
  userId: "u1",
  email: "u1@example.com",
  role: "user",
  orgId: ORG_A,
  principalType: "user",
};

/** The caller's own org owns the agent — the ordinary case. */
function agentBelongsToCallerOrg() {
  mockResolvePrincipalOrgId.mockResolvedValue(ORG_A);
  mockReadAgentScope.mockResolvedValue({
    agentId: "id-a",
    workspaceId: "ws-a",
    organizationId: ORG_A,
  });
}

describe("MemoriesController.create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentBelongsToCallerOrg();
  });

  it("resolves the provider-aware context by slug and creates the memory", async () => {
    // Regression guard for the slug-vs-UUID bug: the POST /memories handler must
    // pass the instance slug through to the embeddings gateway, which resolves it
    // to the instance UUID internally — never cast the slug to a UUID directly.
    mockResolveEmbeddingContext.mockResolvedValue({
      instanceId: "my-assistant",
      dimensions: 1024,
      credentials: { provider: "openai", apiKey: "sk-test" },
    });
    mockEmbedMany.mockResolvedValue([[0.1, 0.2, 0.3]]);
    vi.mocked(upsertMemory).mockResolvedValue({ id: "mem-1", content: "hello", event: "ADD" });

    const controller = new MemoriesController();
    const result = await controller.create(
      { instanceId: "my-assistant", content: "hello" },
      callerOfOrgA,
    );

    expect(mockResolveEmbeddingContext).toHaveBeenCalledWith(asAgentSlug("my-assistant"));
    expect(mockEmbedMany).toHaveBeenCalledWith(
      ["hello"],
      expect.objectContaining({ dimensions: 1024 }),
    );
    expect(upsertMemory).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: asAgentSlug("my-assistant"), content: "hello" }),
    );
    expect(result).toEqual({ memory: { id: "mem-1", content: "hello", event: "ADD" } });
  });

  it("returns 400 when the embedding provider is not configured", async () => {
    mockResolveEmbeddingContext.mockRejectedValue(new Error("Embedding provider not configured."));

    const controller = new MemoriesController();

    await expect(
      controller.create({ instanceId: "my-assistant", content: "hello" }, callerOfOrgA),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mockEmbedMany).not.toHaveBeenCalled();
  });
});

/**
 * The cross-tenant write gate.
 *
 * Every other handler here names its agent in a query string and threads the
 * caller's org into the store. `create` names it in the BODY and used to read no
 * caller at all — so `agent.memory:write`, which Member holds, authorized the
 * caller at its OWN org level and then wrote wherever `body.instanceId` pointed.
 *
 * That is worse than a stray row: a memory is embedded and injected into the
 * target agent's supervisor prompt on its next matching turn, making the write
 * durable cross-tenant prompt injection.
 */
describe("MemoriesController.create — cross-tenant write gate", () => {
  const foreignBody = { instanceId: "agent-of-org-b", content: "remember this" };
  let controller: MemoriesController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new MemoriesController();
    mockResolvePrincipalOrgId.mockImplementation(async (orgId?: string) => orgId ?? null);
    mockResolveEmbeddingContext.mockResolvedValue({
      dimensions: 1536,
      credentials: { provider: "openai" },
    });
    mockEmbedMany.mockResolvedValue([[0.1, 0.2]]);
    vi.mocked(upsertMemory).mockResolvedValue({ id: "m1", content: "x", event: "ADD" });
  });

  it("refuses to write into an agent of another organization", async () => {
    mockReadAgentScope.mockResolvedValue({
      agentId: "id-b",
      workspaceId: "ws-b",
      organizationId: ORG_B,
    });

    await expect(controller.create(foreignBody, callerOfOrgA)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // Nothing written, and nothing even embedded.
    expect(upsertMemory).not.toHaveBeenCalled();
    expect(mockEmbedMany).not.toHaveBeenCalled();
  });

  // Unknown agent and foreign agent are deliberately indistinguishable: a caller
  // of another org must not learn from the status code that the agent exists.
  it("answers 404 for an unknown agent, exactly as for a foreign one", async () => {
    mockReadAgentScope.mockResolvedValue(null);

    await expect(controller.create(foreignBody, callerOfOrgA)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(upsertMemory).not.toHaveBeenCalled();
  });

  it("refuses when the caller's organization cannot be resolved", async () => {
    // No claim AND an ambiguous (multi-org) deployment → ownership is unprovable.
    mockResolvePrincipalOrgId.mockResolvedValue(null);
    mockReadAgentScope.mockResolvedValue({
      agentId: "id-a",
      workspaceId: "ws-a",
      organizationId: ORG_A,
    });

    await expect(
      controller.create(foreignBody, { ...callerOfOrgA, orgId: undefined }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(upsertMemory).not.toHaveBeenCalled();
  });

  it("confines a per-instance API key to its own agent", async () => {
    const instanceKey = { kind: "instance", instanceSlug: "agent-a" } as never;

    await expect(
      controller.create({ instanceId: "agent-b", content: "x" }, instanceKey),
    ).rejects.toBeInstanceOf(NotFoundException);
    // Decided on the slug alone — an instance principal carries no org, so the
    // scope lookup is never needed.
    expect(mockReadAgentScope).not.toHaveBeenCalled();
    expect(upsertMemory).not.toHaveBeenCalled();
  });

  it("still rejects empty content before doing any tenancy work", async () => {
    await expect(
      controller.create({ instanceId: "agent-a", content: "   " }, callerOfOrgA),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mockReadAgentScope).not.toHaveBeenCalled();
  });
});

/**
 * The read/delete paths pass the RESOLVED org, not the raw claim. The store's
 * filter now fails closed on a missing orgId, so forwarding `user?.orgId`
 * verbatim would return an empty list to any caller whose JWT predates the
 * claim — on an ordinary single-org deployment, where `resolvePrincipalOrgId`
 * can answer perfectly well.
 */
describe("MemoriesController — read/delete resolve the caller's organization", () => {
  let controller: MemoriesController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new MemoriesController();
    vi.mocked(searchMemories).mockResolvedValue({ total: 0, memories: [] });
    vi.mocked(deleteMemoryForInstance).mockResolvedValue(true);
  });

  it("passes the resolved organization to the search store", async () => {
    mockResolvePrincipalOrgId.mockResolvedValue(ORG_A);

    await controller.listAll("agent-a", undefined, undefined, undefined, undefined, {
      ...callerOfOrgA,
      orgId: undefined,
    } as never);

    expect(mockResolvePrincipalOrgId).toHaveBeenCalledWith(undefined);
    expect(searchMemories).toHaveBeenCalledWith(
      asAgentSlug("agent-a"),
      expect.objectContaining({ orgId: ORG_A }),
    );
  });

  it("forwards undefined — not null — when the organization is unresolvable", async () => {
    mockResolvePrincipalOrgId.mockResolvedValue(null);

    await controller.listAll("agent-a", undefined, undefined, undefined, undefined, {
      ...callerOfOrgA,
      orgId: undefined,
    } as never);

    // `undefined` is what the store's fail-closed branch keys on; a `null`
    // leaking through would take a different, untested path.
    expect(searchMemories).toHaveBeenCalledWith(
      asAgentSlug("agent-a"),
      expect.objectContaining({ orgId: undefined }),
    );
  });

  it("scopes a single-memory delete to the resolved organization", async () => {
    mockResolvePrincipalOrgId.mockResolvedValue(ORG_A);

    await controller.remove("m1", "agent-a", callerOfOrgA);

    expect(deleteMemoryForInstance).toHaveBeenCalledWith("m1", asAgentSlug("agent-a"), ORG_A);
  });
});
