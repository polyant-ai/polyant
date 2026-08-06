// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Tenancy tests for the live activity-stream SSE endpoint.
 *
 * `activityBus` is process-global. Its events carry an agent slug and name, tool
 * summaries, a channel type with its chat id and sender display name, and up to
 * 600 characters of handoff prompt. The only filter used to be the
 * CLIENT-SUPPLIED `?instance=`, so a caller holding `analytics:read` — a
 * permission Viewer holds — could open this socket and watch every tenant's
 * traffic in real time.
 *
 * These tests drive the real controller against the real bus and a fake Express
 * response, and assert on what was actually written to the wire.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockListAllInstances, mockResolvePrincipalOrgId } = vi.hoisted(() => ({
  mockListAllInstances: vi.fn(),
  mockResolvePrincipalOrgId: vi.fn(),
}));

vi.mock("../instances/store.js", () => ({
  listAllInstances: mockListAllInstances,
  resolvePrincipalOrgId: mockResolvePrincipalOrgId,
}));

import { ActivityStreamController } from "./activity-stream.controller.js";
import { activityBus } from "./activity-bus.js";
import type { FeedEvent } from "./activity-stream.types.js";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import type { Request, Response } from "express";

const ORG_A = "org-a";

const callerOfOrgA: AuthenticatedUser = {
  userId: "u1",
  email: "u1@example.com",
  role: "user",
  orgId: ORG_A,
  principalType: "user",
};

/** Captures everything written, and the close handler the controller registers. */
function makeRes() {
  const written: string[] = [];
  const res = {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: string) => {
      written.push(chunk);
      return true;
    }),
    end: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
    // The controller registers `res.on("error", teardown)` alongside the request
    // listeners; without this the handler throws before it ever subscribes.
    on: vi.fn(),
  } as unknown as Response;
  return { res, written };
}

function makeReq() {
  const handlers: Record<string, () => void> = {};
  const req = {
    on: vi.fn((event: string, fn: () => void) => {
      handlers[event] = fn;
    }),
  } as unknown as Request;
  return { req, handlers };
}

/** A minimal feed event attributed to `slug`. */
function eventFor(slug: string): FeedEvent {
  return {
    id: `evt-${slug}`,
    type: "conversation_started",
    at: new Date().toISOString(),
    instance: { slug, name: slug },
  } as unknown as FeedEvent;
}

/** The event payloads (not heartbeats/comments) that reached the socket. */
function dataEvents(written: string[]): string[] {
  return written.filter((w) => w.startsWith("data: "));
}

describe("GET /api/activity-stream/live — organization scoping", () => {
  let controller: ActivityStreamController;
  const openConnections: Array<() => void> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new ActivityStreamController();
    activityBus.__clearBuffer();
    mockResolvePrincipalOrgId.mockResolvedValue(ORG_A);
    mockListAllInstances.mockResolvedValue([{ slug: "agent-a" }, { slug: "agent-a2" }]);
  });

  afterEach(() => {
    // Close every stream so the module-scoped connection counters do not leak
    // into the next test (the global cap would eventually reject).
    for (const close of openConnections.splice(0)) close();
  });

  async function connect(user: AuthenticatedUser | undefined, instance?: string) {
    const { res, written } = makeRes();
    const { req, handlers } = makeReq();
    await controller.live(req, res, user, instance);
    openConnections.push(() => handlers.close?.());
    return { written, close: () => handlers.close?.() };
  }

  it("forwards an event for an agent of the caller's organization", async () => {
    const { written } = await connect(callerOfOrgA);

    activityBus.emitEvent(eventFor("agent-a"));

    expect(dataEvents(written)).toHaveLength(1);
    expect(dataEvents(written)[0]).toContain("agent-a");
  });

  it("does NOT forward an event for an agent of another organization", async () => {
    const { written } = await connect(callerOfOrgA);

    activityBus.emitEvent(eventFor("agent-of-org-b"));

    // The whole point: nothing about the foreign agent reaches the socket.
    expect(dataEvents(written)).toHaveLength(0);
  });

  it("ignores the client's ?instance when it names a foreign agent", async () => {
    // The client asking for another tenant's agent must not widen what it sees —
    // the tenancy filter runs first and is independent of this parameter.
    const { written } = await connect(callerOfOrgA, "agent-of-org-b");

    activityBus.emitEvent(eventFor("agent-of-org-b"));

    expect(dataEvents(written)).toHaveLength(0);
  });

  it("still applies the ?instance narrowing inside the caller's own organization", async () => {
    const { written } = await connect(callerOfOrgA, "agent-a");

    activityBus.emitEvent(eventFor("agent-a2"));
    activityBus.emitEvent(eventFor("agent-a"));

    expect(dataEvents(written)).toHaveLength(1);
    expect(dataEvents(written)[0]).toContain("agent-a");
  });

  it("forwards nothing when the caller's organization cannot be resolved", async () => {
    mockResolvePrincipalOrgId.mockResolvedValue(null);
    const { written } = await connect({ ...callerOfOrgA, orgId: undefined });

    activityBus.emitEvent(eventFor("agent-a"));

    // Fail closed: ownership is unprovable, so nothing is provably visible.
    expect(dataEvents(written)).toHaveLength(0);
    expect(mockListAllInstances).not.toHaveBeenCalled();
  });

  it("drops an event that names no agent, since it cannot be attributed", async () => {
    const { written } = await connect(callerOfOrgA);

    activityBus.emitEvent({ id: "e", type: "conversation_started", at: "" } as unknown as FeedEvent);

    expect(dataEvents(written)).toHaveLength(0);
  });

  it("scopes the agent lookup to the resolved organization", async () => {
    await connect(callerOfOrgA);

    expect(mockListAllInstances).toHaveBeenCalledWith(ORG_A);
  });
});
