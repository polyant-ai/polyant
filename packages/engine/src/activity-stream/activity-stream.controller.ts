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
 *   - Server-side `?instance=<slug>` filter — events for other agents are
 *     never emitted on this socket (no client-side trust).
 */

import { Controller, Get, Query, Req, Res } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { activityBus } from "./activity-bus.js";
import type { FeedEvent } from "./activity-stream.types.js";
import { config } from "../config.js";
import { CurrentUser } from "../auth/index.js";
import type { AuthenticatedUser } from "../auth/auth.types.js";

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

@SkipThrottle()
@Controller("api/activity-stream")
export class ActivityStreamController {
  @Get("live")
  live(
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Query("instance") instance?: string,
  ): void {
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
      // Server-side filter: when the client passed `?instance=<slug>` only
      // forward events scoped to that instance.
      if (instance && evt.instance?.slug !== instance) return;
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

    const teardown = () => {
      if (closed) {
        // Even if `closed` was flipped by a write failure inside flush/heartbeat,
        // we may still owe a counter decrement.
        decrementCounters();
        return;
      }
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      try {
        res.end();
      } catch {
        // ignored
      }
      decrementCounters();
    };

    req.on("close", teardown);
    req.on("error", teardown);
    res.on("error", teardown);
  }
}
