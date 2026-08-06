// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Activity Stream — live SSE endpoint.
 *
 * Replaces the legacy `GET /api/activity-stream/real` polling endpoint.
 * Subscribes to the in-process ActivityBus and pipes events to the
 * connected client as Server-Sent Events. Fire-and-forget by design:
 * an event emitted with no subscribers is dropped, and a client that
 * connects after a turn has started will only see events from that
 * point onward.
 *
 * Resource limits (enforced server-side):
 *   - Global cap:   `SSE_MAX_CONNECTIONS` concurrent subscribers (default 50).
 *   - Per-user cap: `SSE_MAX_CONNECTIONS_PER_USER` per authenticated user
 *                   (default 5). Both excess cases return HTTP 503 with a
 *                   `Retry-After: 60` header so clients can back off.
 *   - Server-side `?instance=<slug>` filter — events for other instances are
 *     never emitted on this socket (no client-side trust).
 *   - Server-side ORGANIZATION filter — see `resolveVisibleSlugs`.
 */

import { Controller, Get, Query, Req, Res } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { activityBus } from "./activity-bus.js";
import type { FeedEvent } from "./activity-stream.types.js";
import { config } from "../config.js";
import { CurrentUser } from "../auth/index.js";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import { RequirePermission, Permission } from "../authz/index.js";
import { listAllInstances, resolvePrincipalOrgId } from "../instances/store.js";

/**
 * Per-client backpressure cap. If a slow client accumulates more than this
 * many pending events, we drop the oldest to keep memory bounded — better
 * to lose a few events on a frozen connection than to pin RAM forever.
 */
const MAX_PENDING_PER_CLIENT = 200;

/** Global SSE connection counter (module-scoped). */
let activeConnections = 0;

/** Per-user SSE connection counters (module-scoped). */
const perUserConnections = new Map<string, number>();

/**
 * The agent slugs this caller is allowed to see events for, resolved ONCE per
 * connection.
 *
 * `activityBus` is process-global and its events carry an agent slug, a tool
 * summary, a channel type with its chat id and sender name, and up to 600
 * characters of handoff prompt. The only filter used to be the client-supplied
 * `?instance=`, so a caller holding `analytics:read` — which Viewer holds — could
 * open this socket and watch every tenant's traffic in real time.
 *
 * Resolved at connect time into a Set rather than per event on purpose: the
 * handler is synchronous and runs on every event on the bus, so a lookup there
 * would put a query on the hot path. The trade-off is that an agent created
 * DURING a connection is not visible until the client reconnects — which matches
 * what this endpoint already promises ("a client that connects after a turn has
 * started will only see events from that point onward").
 *
 * No platform-admin bypass, deliberately: the sibling org-scoped read paths
 * (conversations, analytics, audit) do not grant one either.
 */
async function resolveVisibleSlugs(user: AuthenticatedUser | undefined): Promise<Set<string>> {
  const orgId = await resolvePrincipalOrgId(user?.orgId);
  // No resolvable organization → nothing is provably visible. Fail closed.
  if (!orgId) return new Set();

  const instances = await listAllInstances(orgId);
  return new Set(instances.map((i) => i.slug));
}

@SkipThrottle()
@Controller("api/activity-stream")
export class ActivityStreamController {
  // Org-scoped read observability; the route has no `:slug` scope.
  @RequirePermission(Permission.ANALYTICS_READ)
  @Get("live")
  async live(
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Query("instance") instance?: string,
  ): Promise<void> {
    const maxConnections = config.activityStream.maxConnections;
    const maxPerUser = config.activityStream.maxPerUser;

    // Global cap.
    if (activeConnections >= maxConnections) {
      res.setHeader("Retry-After", "60");
      res.status(503).json({
        error: "Too many concurrent activity-stream subscribers; try again later",
        limit: maxConnections,
      });
      return;
    }

    // Resolved BEFORE any connection counter is incremented or a header is sent,
    // so a failure here cannot leak a slot or a half-open stream.
    const visibleSlugs = await resolveVisibleSlugs(user);

    // Per-user cap. Unauthenticated requests are blocked by the global AuthGuard,
    // but we guard defensively in case the route is ever marked @Public.
    const userId = user?.userId ?? null;
    if (userId) {
      const current = perUserConnections.get(userId) ?? 0;
      if (current >= maxPerUser) {
        res.setHeader("Retry-After", "60");
        res.status(503).json({
          error: "Too many concurrent activity-stream subscribers for this user",
          limit: maxPerUser,
        });
        return;
      }
      perUserConnections.set(userId, current + 1);
    }

    activeConnections += 1;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    // Initial comment line keeps proxies / browsers from buffering headers
    // until the first real event lands.
    res.write(": connected\n\n");

    const queue: FeedEvent[] = [];
    let writing = false;
    let closed = false;
    let decremented = false;

    const flush = () => {
      if (writing || closed) return;
      writing = true;
      while (queue.length > 0) {
        const evt = queue.shift()!;
        try {
          res.write(`data: ${JSON.stringify(evt)}\n\n`);
        } catch {
          // Connection broke between checks; tear down.
          closed = true;
          break;
        }
      }
      writing = false;
    };

    const handler = (evt: FeedEvent) => {
      if (closed) return;
      // Tenancy filter FIRST, and independent of any client input: the bus is
      // process-global, so without this the socket carries every organization's
      // agent slugs, tool summaries, channel senders and handoff prompts.
      // An event with no agent cannot be attributed, so it is not forwarded.
      if (!evt.instance?.slug || !visibleSlugs.has(evt.instance.slug)) return;
      // Server-side filter: when the client passed `?instance=<slug>` only
      // forward events scoped to that instance.
      if (instance && evt.instance.slug !== instance) return;
      queue.push(evt);
      if (queue.length > MAX_PENDING_PER_CLIENT) {
        // Backpressure: drop oldest events; preserve the most recent.
        queue.splice(0, queue.length - MAX_PENDING_PER_CLIENT);
      }
      flush();
    };

    const unsubscribe = activityBus.subscribe(handler);

    // Heartbeat to keep idle proxies (Render, nginx, …) from killing the
    // connection at 30–60 s of silence. Comment lines are ignored by the
    // EventSource browser API.
    const heartbeat = setInterval(() => {
      if (closed) return;
      try {
        res.write(": ping\n\n");
      } catch {
        closed = true;
      }
    }, 25_000);

    const decrementCounters = () => {
      if (decremented) return;
      decremented = true;
      activeConnections = Math.max(0, activeConnections - 1);
      if (userId) {
        const remaining = (perUserConnections.get(userId) ?? 1) - 1;
        if (remaining <= 0) perUserConnections.delete(userId);
        else perUserConnections.set(userId, remaining);
      }
    };

    /**
     * Release EVERY resource on EVERY path, idempotently (express can fire
     * `close` and `error`, so this runs more than once).
     *
     * `closed` may already be true because a write failed inside `flush()` or the
     * heartbeat. That path still owes the interval and the bus subscription:
     * returning early there leaked a 25 s timer plus a live subscription (holding
     * `visibleSlugs` and `res`) for the process lifetime, and made the bus invoke
     * one dead handler per abruptly-dropped client on every event.
     *
     * `clearInterval` and the unsubscribe (`emitter.off`) are both no-ops when
     * already applied, so repeated calls are safe.
     */
    const teardown = () => {
      const wasOpen = !closed;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      // Only end a response that was still considered open — ending twice is
      // harmless but pointless, and the write already failed on the closed path.
      if (wasOpen) {
        try {
          res.end();
        } catch {
          // ignored
        }
      }
      decrementCounters();
    };

    req.on("close", teardown);
    req.on("error", teardown);
    res.on("error", teardown);
  }
}
