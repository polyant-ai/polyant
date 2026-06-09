// SPDX-License-Identifier: AGPL-3.0-or-later

import { API_BASE } from "@/lib/api";

export interface StreamCallbacks {
  /** Assistant text delta. Append to the current message content. */
  onTextDelta: (text: string) => void;
  /** Reasoning text delta (from a thinking-capable model). Append to the current reasoning buffer. */
  onReasoningDelta: (text: string) => void;
  /** Anthropic-only: signature for the most recently completed reasoning block. */
  onReasoningSignature?: (signature: string) => void;
  /** Marker that a redacted reasoning block occurred (no payload). */
  onReasoningRedacted?: () => void;
  /** A new step in the multi-step loop has started. */
  onStepStart: (index: number, stepType: string) => void;
  /** The current step has finished. */
  onStepFinish: (index: number, finishReason: string) => void;
  /** A tool call has been emitted in the current step. */
  onToolCall: (id: string, name: string, args: unknown) => void;
  /** Result for a previously-emitted tool call. */
  onToolResult: (id: string, result: unknown) => void;
  /**
   * Stream completed successfully. The engine echoes the persisted identifiers
   * (full conversationId + assistant message id) so the client can later fetch
   * this turn's debug payload. Absent on the EOF-drain fallback.
   */
  onDone: (meta?: { conversationId?: string; messageId?: string }) => void;
  /** A non-recoverable error occurred. */
  onError: (error: Error) => void;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface StreamRequestOptions {
  /** Instance slug — also used as the `model` field for the OpenAI-compat handler. */
  instanceSlug: string;
  messages: ChatMessage[];
  chatId: string;
  signal?: AbortSignal;
  authToken?: string;
}

/**
 * Connects to the engine's native typed SSE streaming endpoint
 * (`POST /api/instances/:slug/chat/stream`) and dispatches typed callbacks.
 *
 * The endpoint emits structured SSE events:
 *   step-start, reasoning-delta, reasoning-signature, reasoning-redacted,
 *   tool-call, tool-result, text-delta, step-finish, done, error
 *
 * Each event has its own `event:` line and a JSON `data:` payload.
 */
export async function streamChatCompletion(
  options: StreamRequestOptions,
  callbacks: StreamCallbacks,
): Promise<void> {
  const { instanceSlug, messages, chatId, signal, authToken } = options;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

  let response: Response;
  try {
    response = await fetch(
      `${API_BASE}/api/instances/${encodeURIComponent(instanceSlug)}/chat/stream`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: instanceSlug,
          messages,
          stream: true,
          chat_id: chatId,
        }),
        signal,
      },
    );
  } catch (err) {
    if (signal?.aborted) return;
    callbacks.onError(err instanceof Error ? err : new Error("Network error"));
    return;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    callbacks.onError(new Error(`HTTP ${response.status}: ${body}`));
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    callbacks.onError(new Error("No response body"));
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const raw of events) {
        const evt = parseSseEvent(raw);
        if (!evt) continue;
        if (!dispatch(evt, callbacks)) return; // returned false → stream done
      }
    }

    // Drain trailing buffer (last event may not have a trailing \n\n if the
    // server flushed exactly at EOF).
    if (buffer.trim()) {
      const evt = parseSseEvent(buffer);
      if (evt) dispatch(evt, callbacks);
    }

    callbacks.onDone();
  } catch (err) {
    if (signal?.aborted) return;
    callbacks.onError(err instanceof Error ? err : new Error("Stream read error"));
  }
}

interface SseEvent {
  event: string;
  data: unknown;
}

/** Parse a single `event:`/`data:` block. Returns null if malformed. */
export function parseSseEvent(raw: string): SseEvent | null {
  let event = "message";
  let dataLine = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7).trim();
    else if (line.startsWith("data: ")) dataLine += line.slice(6);
  }
  if (!dataLine) return null;
  try {
    return { event, data: JSON.parse(dataLine) };
  } catch {
    return null;
  }
}

/**
 * Dispatch one typed event to the callbacks. Returns `false` when the stream
 * has signaled completion (`done` event) so the caller stops reading.
 */
export function dispatch(evt: SseEvent, cb: StreamCallbacks): boolean {
  const data = evt.data as Record<string, unknown> | undefined;
  switch (evt.event) {
    case "step-start": {
      const index = typeof data?.index === "number" ? data.index : 0;
      const stepType = typeof data?.stepType === "string" ? data.stepType : "initial";
      cb.onStepStart(index, stepType);
      return true;
    }
    case "step-finish": {
      const index = typeof data?.index === "number" ? data.index : 0;
      const finishReason = typeof data?.finishReason === "string" ? data.finishReason : "stop";
      cb.onStepFinish(index, finishReason);
      return true;
    }
    case "reasoning-delta": {
      if (typeof data?.text === "string") cb.onReasoningDelta(data.text);
      return true;
    }
    case "reasoning-signature": {
      if (typeof data?.signature === "string" && cb.onReasoningSignature) {
        cb.onReasoningSignature(data.signature);
      }
      return true;
    }
    case "reasoning-redacted": {
      cb.onReasoningRedacted?.();
      return true;
    }
    case "tool-call": {
      const id = typeof data?.id === "string" ? data.id : "";
      const name = typeof data?.name === "string" ? data.name : "";
      if (id && name) cb.onToolCall(id, name, data?.args);
      return true;
    }
    case "tool-result": {
      const id = typeof data?.id === "string" ? data.id : "";
      if (id) cb.onToolResult(id, data?.result);
      return true;
    }
    case "text-delta": {
      if (typeof data?.text === "string") cb.onTextDelta(data.text);
      return true;
    }
    case "done": {
      cb.onDone({
        conversationId: typeof data?.conversationId === "string" ? data.conversationId : undefined,
        messageId: typeof data?.messageId === "string" ? data.messageId : undefined,
      });
      return false;
    }
    case "error": {
      const message = typeof data?.message === "string" ? data.message : "stream error";
      cb.onError(new Error(message));
      return false;
    }
    default:
      return true;
  }
}
