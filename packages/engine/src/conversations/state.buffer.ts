// SPDX-License-Identifier: AGPL-3.0-or-later

import { loadConversationState, flushConversationState } from "./state.store.js";

/** Reserved key holding the server-seeded, trusted channel identity. Tools read
 *  it via `ctx.state.channel`; it is never written by the LLM. */
export const CHANNEL_STATE_KEY = "_channel";

/** Max serialized size of a conversation's state blob, enforced at write time so
 *  a tool cannot grow an unbounded JSONB row (indirectly from LLM output). */
export const MAX_STATE_BYTES = 64 * 1024;

/** Trusted channel identity seeded under `_channel`. */
export interface ChannelStateIdentity {
  type: string;
  id: string;
  userName?: string;
}

/**
 * Tool-facing API exposed as `ctx.state`. A single shared key/value space per
 * conversation — every tool reads/writes the same keys. Values must be
 * JSON-serializable. Writes are buffered in-memory and committed on pipeline
 * success (never on an aborted run).
 */
export interface ConversationStateApi {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  getAll(): Record<string, unknown>;
  delete(key: string): void;
  /** Trusted channel identity (server-seeded), or undefined for channels without one. */
  readonly channel: ChannelStateIdentity | undefined;
}

/** Strip non-JSON values and surface a tool bug early rather than at flush time. */
function toJsonValue(key: string, value: unknown): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (err) {
    throw new Error(
      `conversation state: value for "${key}" is not JSON-serializable: ${(err as Error).message}`,
    );
  }
  if (serialized === undefined) {
    throw new Error(`conversation state: value for "${key}" is undefined / not serializable`);
  }
  return JSON.parse(serialized);
}

/**
 * Per-pipeline-run, in-memory view of a conversation's shared state.
 *
 * Constructed from the DB-loaded blob at pipeline start; tool writes mutate the
 * buffer only. `flush()` persists the dirty/removed keys — called from
 * `runPipelinePost` AFTER the abort gate, so an aborted run leaves no DB trace
 * (same commit-on-success contract as messages/summary/memory).
 */
export class ConversationStateBuffer {
  private readonly data: Record<string, unknown>;
  private readonly dirty = new Set<string>();
  private readonly removed = new Set<string>();

  constructor(
    private readonly conversationId: string,
    private readonly agentId: string | null,
    initial: Record<string, unknown> = {},
  ) {
    this.data = { ...initial };
  }

  /** Load the persisted state and build a buffer. Awaited once per pipeline run. */
  static async load(
    conversationId: string,
    agentId: string | null,
  ): Promise<ConversationStateBuffer> {
    const initial = await loadConversationState(conversationId);
    return new ConversationStateBuffer(conversationId, agentId, initial);
  }

  /**
   * Overlay the trusted channel identity under the reserved `_channel` key.
   * Marked dirty only when it differs from the loaded value, so an unchanged
   * channel does not trigger a write on every turn.
   */
  seedChannel(channel: ChannelStateIdentity): void {
    if (JSON.stringify(this.data[CHANNEL_STATE_KEY]) !== JSON.stringify(channel)) {
      this.data[CHANNEL_STATE_KEY] = channel;
      this.dirty.add(CHANNEL_STATE_KEY);
      this.removed.delete(CHANNEL_STATE_KEY);
    }
  }

  private get(key: string): unknown {
    return this.data[key];
  }

  private getAll(): Record<string, unknown> {
    // Defensive deep copy — a tool must not mutate internal state by reference.
    return structuredClone(this.data);
  }

  private set(key: string, value: unknown): void {
    const clean = toJsonValue(key, value);
    const candidate = { ...this.data, [key]: clean };
    const size = Buffer.byteLength(JSON.stringify(candidate), "utf8");
    if (size > MAX_STATE_BYTES) {
      throw new Error(
        `conversation state: writing "${key}" would exceed ${MAX_STATE_BYTES} bytes (got ${size})`,
      );
    }
    this.data[key] = clean;
    this.dirty.add(key);
    this.removed.delete(key);
  }

  private delete(key: string): void {
    if (!(key in this.data)) return;
    delete this.data[key];
    this.dirty.delete(key);
    this.removed.add(key);
  }

  /** Build the tool-facing facade — exposes only the API surface, never flush/internal state.
   *  Arrow functions capture `this` lexically (no aliasing); the `channel` getter stays
   *  reactive by delegating to a closure rather than the object literal's own `this`. */
  api(): ConversationStateApi {
    const readChannel = (): ChannelStateIdentity | undefined => {
      const c = this.get(CHANNEL_STATE_KEY);
      return c && typeof c === "object" ? (c as ChannelStateIdentity) : undefined;
    };
    return {
      get: (k) => this.get(k),
      set: (k, v) => this.set(k, v),
      getAll: () => this.getAll(),
      delete: (k) => this.delete(k),
      get channel(): ChannelStateIdentity | undefined {
        return readChannel();
      },
    };
  }

  /** Snapshot for read-only prompt injection (defensive copy). */
  snapshot(): Record<string, unknown> {
    return this.getAll();
  }

  /** Persist dirty/removed keys. Caller (runPipelinePost) only calls this on a
   *  successful, non-aborted run. No-op when nothing changed. */
  async flush(): Promise<void> {
    if (this.dirty.size === 0 && this.removed.size === 0) return;
    const set: Record<string, unknown> = {};
    for (const key of this.dirty) set[key] = this.data[key];
    await flushConversationState(this.conversationId, this.agentId, set, [...this.removed]);
    this.dirty.clear();
    this.removed.clear();
  }
}
