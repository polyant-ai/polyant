// SPDX-License-Identifier: AGPL-3.0-or-later

import { Injectable, NotFoundException } from "@nestjs/common";
import { DefaultRequestHandler } from "@a2a-js/sdk/server";

import { config } from "../../config.js";
import { TtlCache } from "../../utils/ttl-cache.js";
import { findInstanceBySlug } from "../../instances/store.js";
import type { InstanceSlug } from "../../instances/identifiers.js";
import type { StreamMessageHandler } from "../../channels/types.js";
import { BoundedTaskStore } from "./bounded-task.store.js";
import { buildAgentCard } from "./agent-card.builder.js";
import { createPolyantExecutor } from "./polyant-agent.executor.js";

/**
 * Lazily builds and TTL-caches one DefaultRequestHandler per instance slug (the
 * Agent Card is per-instance). The 30s TTL matches config-resolver, so card
 * edits (name/description) propagate without a restart.
 *
 * One task store is shared across slugs, and it is a `BoundedTaskStore` (NOT
 * the SDK's never-evicting `InMemoryTaskStore`): the handler cache bounds
 * HANDLERS, not tasks, and each saved task carries its message history, so an
 * unbounded store is a heap-exhaustion vector for a `@Public()` endpoint.
 */
@Injectable()
export class A2aHandlerRegistry {
  private streamHandler?: StreamMessageHandler;
  private readonly taskStore = new BoundedTaskStore();
  private readonly cache = new TtlCache<string, DefaultRequestHandler>({ maxSize: 200, ttlMs: 30_000 });

  setStreamMessageHandler(handler: StreamMessageHandler): void {
    this.streamHandler = handler;
  }

  async getHandler(slug: InstanceSlug): Promise<DefaultRequestHandler> {
    const cached = this.cache.get(slug);
    if (cached) return cached;
    if (!this.streamHandler) throw new Error("A2aHandlerRegistry: stream message handler not set");

    const instance = await findInstanceBySlug(slug);
    if (!instance) throw new NotFoundException(`Instance "${slug}" not found`);

    const baseUrl = config.server.baseUrl ?? `http://localhost:${config.server.port}`;
    const card = buildAgentCard(instance, baseUrl);
    const executor = createPolyantExecutor(slug, this.streamHandler);
    const handler = new DefaultRequestHandler(card, this.taskStore, executor);

    this.cache.set(slug, handler);
    return handler;
  }
}
