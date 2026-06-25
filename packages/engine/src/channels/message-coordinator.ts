// SPDX-License-Identifier: AGPL-3.0-or-later

import type { IncomingMessage, OutgoingMessage } from "./types.js";

/**
 * Per-conversation coordinator for inbound messaging channels that tend to
 * receive user messages in quick fragmented bursts (WhatsApp, Telegram).
 *
 * Design (cancel-and-restart with soft-debounce + delayed typing):
 *
 * 1. First fragment arrives → arm two timers:
 *    - typingTimer at `typingDelayMs` (default 1500ms)
 *    - pipelineTimer at `softDebounceMs` (default 2000ms)
 * 2. Additional fragments within the soft-debounce window → append to buffer
 *    and reset both timers (sliding).
 * 3. typingTimer fires → invoke `sendTyping(lastSid)` once for this burst.
 * 4. pipelineTimer fires → invoke the real handler with concatenated text and
 *    an AbortSignal.
 * 5. A fragment that arrives AFTER the pipeline has started → abort the in-flight
 *    pipeline and re-arm the pipelineTimer (another soft-debounce window starts).
 * 6. If `maxRestarts` is reached, subsequent fragments no longer cancel — they
 *    accumulate and are flushed in a new pipeline once the current one finishes.
 *
 * Rationale: delayed typing gives a human-like "starting to think" latency,
 * while cancel-and-restart keeps the pipeline responsive to updated intent
 * without paying the full 3–5s debounce of the classic design.
 */

export interface MessageCoordinatorOptions {
  /** Pre-pipeline coalescing window (ms). Burst fragments within this window collapse into one call. */
  softDebounceMs: number;
  /** Delay (ms) before sending the typing indicator. 0 = immediate. */
  typingDelayMs: number;
  /** Cap on consecutive cancel-and-restart cycles before degrading to sequential flushes. */
  maxRestarts: number;
  /** The real message handler (pipeline). Invoked once per flush with the concatenated text. */
  handler: (msg: IncomingMessage, signal: AbortSignal) => Promise<OutgoingMessage>;
  /** Channel send callback used after a flush to deliver the response. */
  sendOutbound: (
    instanceSlug: string,
    channelType: string,
    channelId: string,
    text: string,
  ) => Promise<void>;
  /**
   * Optional typing-indicator callback. Called once per burst after `typingDelayMs`
   * with the instance/channel info and the most recent inbound message SID
   * (needed for WhatsApp/Twilio).
   */
  sendTyping?: (
    instanceSlug: string,
    channelType: string,
    channelId: string,
    messageSid?: string,
  ) => Promise<void>;
  /** Optional override of the keying strategy. Defaults to `${agentId}:${channelType}:${channelId}`. */
  conversationKey?: (msg: IncomingMessage) => string;
}

interface ConversationState {
  /** Ordered list of fragment texts awaiting pipeline dispatch. */
  buffer: string[];
  /** The seed IncomingMessage of the current burst (preserves metadata). */
  seed: IncomingMessage;
  /** Most recent inbound message SID (Twilio) — used by `sendTyping`. */
  lastSid: string | undefined;
  /** Aggregated attachments from all fragments received so far in this burst. */
  attachments: NonNullable<IncomingMessage["attachments"]>;
  /** Scheduled typing fire (null if already fired or not yet armed). */
  typingTimer: ReturnType<typeof setTimeout> | null;
  /** Whether `sendTyping` was already invoked for this burst. */
  typingSent: boolean;
  /** Scheduled pipeline fire (null if pipeline already running). */
  pipelineTimer: ReturnType<typeof setTimeout> | null;
  /** Current in-flight pipeline controller (null if idle). */
  currentAbort: AbortController | null;
  /** Number of consecutive aborts triggered by newly-arrived fragments. */
  restartCount: number;
  /** Serialization chain for pipeline runs on the same conversation. */
  flushChain: Promise<unknown>;
}

function defaultKey(msg: IncomingMessage): string {
  return `${msg.agentId}:${msg.channelType}:${msg.channelId}`;
}

function extractMessageSid(msg: IncomingMessage): string | undefined {
  const sid = msg.metadata?.messageSid;
  return typeof sid === "string" && sid.length > 0 ? sid : undefined;
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || err.message.toLowerCase().includes("aborted");
}

export class MessageCoordinator {
  private readonly states = new Map<string, ConversationState>();

  constructor(private readonly opts: MessageCoordinatorOptions) {
    if (opts.softDebounceMs < 0) {
      throw new Error("MessageCoordinator: softDebounceMs must be >= 0");
    }
    if (opts.typingDelayMs < 0) {
      throw new Error("MessageCoordinator: typingDelayMs must be >= 0");
    }
    if (opts.maxRestarts < 0) {
      throw new Error("MessageCoordinator: maxRestarts must be >= 0");
    }
  }

  /**
   * Entry point called on every inbound message. Returns synchronously with
   * `{ text: "" }` — the channel adapter must NOT treat the empty text as the
   * reply. The real response is delivered later via `sendOutbound`.
   */
  onMessage(msg: IncomingMessage): Promise<OutgoingMessage> {
    const key = (this.opts.conversationKey ?? defaultKey)(msg);
    const state = this.states.get(key);

    if (!state) {
      this.startBurst(key, msg);
      return Promise.resolve({ text: "" });
    }

    // Append fragment to the burst
    state.buffer.push(msg.text);
    const sid = extractMessageSid(msg);
    if (sid) state.lastSid = sid;
    if (msg.attachments?.length) state.attachments.push(...msg.attachments);

    if (state.currentAbort) {
      // Pipeline in flight — decide whether to abort and restart, or accumulate.
      if (state.restartCount < this.opts.maxRestarts) {
        state.currentAbort.abort();
        state.currentAbort = null;
        state.restartCount++;
        // Fragments under processing are restored into the buffer by the flushChain
        // catch branch (see doFlush). We just re-arm the pipeline timer here.
        this.armPipelineTimer(key);
      }
      // else: degraded — keep fragment in buffer; a new pipeline will be armed
      // by finalizePipeline() once the current run completes.
    } else {
      // Pipeline not yet started — reset sliding timers.
      this.armPipelineTimer(key);
      if (!state.typingSent) this.armTypingTimer(key);
    }

    return Promise.resolve({ text: "" });
  }

  /** Shut down: clear all timers, abort in-flight pipelines, drop buffered state. */
  shutdown(): void {
    for (const state of this.states.values()) {
      if (state.typingTimer) clearTimeout(state.typingTimer);
      if (state.pipelineTimer) clearTimeout(state.pipelineTimer);
      if (state.currentAbort) state.currentAbort.abort();
    }
    this.states.clear();
  }

  // -- internals -------------------------------------------------------------

  private startBurst(key: string, msg: IncomingMessage): void {
    const state: ConversationState = {
      buffer: [msg.text],
      seed: msg,
      lastSid: extractMessageSid(msg),
      attachments: msg.attachments ? [...msg.attachments] : [],
      typingTimer: null,
      typingSent: false,
      pipelineTimer: null,
      currentAbort: null,
      restartCount: 0,
      flushChain: Promise.resolve(),
    };
    this.states.set(key, state);
    this.armPipelineTimer(key);
    this.armTypingTimer(key);
  }

  private armPipelineTimer(key: string): void {
    const state = this.states.get(key);
    if (!state) return;
    if (state.pipelineTimer) clearTimeout(state.pipelineTimer);
    state.pipelineTimer = setTimeout(() => this.onPipelineTimer(key), this.opts.softDebounceMs);
  }

  private armTypingTimer(key: string): void {
    const state = this.states.get(key);
    if (!state) return;
    if (state.typingTimer) clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => this.onTypingTimer(key), this.opts.typingDelayMs);
  }

  private onTypingTimer(key: string): void {
    const state = this.states.get(key);
    if (!state || state.typingSent) return;
    state.typingSent = true;
    state.typingTimer = null;
    if (!this.opts.sendTyping) return;
    this.opts
      .sendTyping(
        state.seed.agentId,
        state.seed.channelType,
        state.seed.channelId,
        state.lastSid,
      )
      .catch((err) =>
        console.error(
          `[coordinator] sendTyping failed for ${state.seed.channelType}:${state.seed.channelId}:`,
          err,
        ),
      );
  }

  private onPipelineTimer(key: string): void {
    const state = this.states.get(key);
    if (!state) return;
    state.pipelineTimer = null;

    // Snapshot the fragments to process + clear the buffer. New fragments arriving
    // during the run go to the fresh buffer; on abort, the snapshot is restored.
    const fragments = [...state.buffer];
    state.buffer = [];
    const burstAttachments = state.attachments.length > 0 ? [...state.attachments] : undefined;
    state.attachments = [];

    const abortController = new AbortController();
    state.currentAbort = abortController;
    const signal = abortController.signal;

    const combinedText = fragments.join("\n");
    const combined: IncomingMessage = {
      ...state.seed,
      text: combinedText,
      attachments: burstAttachments,
    };

    state.flushChain = state.flushChain
      .then(() => this.doFlush(key, state, combined, signal, fragments, burstAttachments))
      .catch((err) => {
        console.error(`[coordinator] flushChain unhandled error for ${key}:`, err);
      });
  }

  private async doFlush(
    key: string,
    state: ConversationState,
    combined: IncomingMessage,
    signal: AbortSignal,
    fragments: string[],
    burstAttachments: IncomingMessage["attachments"],
  ): Promise<void> {
    let response: OutgoingMessage | undefined;
    try {
      response = await this.opts.handler(combined, signal);
    } catch (err) {
      if (isAbortError(err) || signal.aborted) {
        this.restoreOnAbort(state, fragments, burstAttachments, signal);
        return;
      }
      console.error(
        `[coordinator] handler error for ${combined.channelType}:${combined.channelId}:`,
        err,
      );
      this.finalizePipeline(key, state, signal);
      return;
    }

    // Another abort may have landed while awaiting the handler — treat it the same.
    if (signal.aborted) {
      this.restoreOnAbort(state, fragments, burstAttachments, signal);
      return;
    }

    if (response.text) {
      try {
        await this.opts.sendOutbound(
          combined.agentId,
          combined.channelType,
          combined.channelId,
          response.text,
        );
      } catch (err) {
        console.error(
          `[coordinator] sendOutbound failed for ${combined.channelType}:${combined.channelId}:`,
          err,
        );
      }
    }

    this.finalizePipeline(key, state, signal);
  }

  /** On abort: restore the in-flight fragments/attachments to the head of the buffer. */
  private restoreOnAbort(
    state: ConversationState,
    fragments: string[],
    burstAttachments: IncomingMessage["attachments"],
    signal: AbortSignal,
  ): void {
    state.buffer = [...fragments, ...state.buffer];
    if (burstAttachments?.length) {
      state.attachments = [...burstAttachments, ...state.attachments];
    }
    if (state.currentAbort?.signal === signal) state.currentAbort = null;
  }

  /**
   * After a successful (or errored, non-aborted) run, clear in-flight state.
   * If fragments accumulated during the run (degraded mode), arm a new pipeline.
   * Otherwise, delete the conversation state entirely.
   */
  private finalizePipeline(key: string, state: ConversationState, signal: AbortSignal): void {
    if (state.currentAbort?.signal === signal) state.currentAbort = null;
    state.restartCount = 0;
    state.typingSent = false;
    state.lastSid = undefined;

    if (state.buffer.length > 0) {
      this.armPipelineTimer(key);
      if (this.opts.typingDelayMs > 0) this.armTypingTimer(key);
    } else {
      if (state.typingTimer) clearTimeout(state.typingTimer);
      if (state.pipelineTimer) clearTimeout(state.pipelineTimer);
      this.states.delete(key);
    }
  }
}
