// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useReducer, useCallback, useRef } from "react";
import {
  streamChatCompletion,
  type ChatMessage as SSEMessage,
} from "../_lib/stream-parser";
import {
  api,
  type ConversationMessage,
  type ReasoningDetail,
  type StepDetail,
} from "@/lib/api";

// ── Types ───────────────────────────────────────────────────────────

/**
 * Live representation of a step while the assistant is streaming. The fields
 * are populated incrementally by SSE events:
 *  - `toolCall` arrives via `tool-call`
 *  - `toolResult` arrives via `tool-result`
 *  - `text` is appended via `text-delta` (only the step that ends in plain text)
 *  - `finishReason` arrives via `step-finish`
 */
export interface LiveStep {
  index: number;
  stepType: string;
  text: string;
  toolCalls: { toolCallId: string; toolName: string; args: unknown }[];
  toolResults: { toolCallId: string; result: unknown }[];
  finishReason?: string;
  /** True once `step-finish` has arrived for this index. */
  done: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** Per-step view used for live rendering AND historical playback. */
  steps: LiveStep[];
  /** Reasoning text accumulated during the stream (signature attached on close). */
  reasoning: ReasoningDetail[];
  isStreaming: boolean;
  createdAt: string | null;
}

export interface ChatState {
  messages: ChatMessage[];
  isStreaming: boolean;
  error: string | null;
  chatId: string;
  conversationId: string | null;
  instanceSlug: string;
}

// ── Actions ─────────────────────────────────────────────────────────

export type ChatAction =
  | { type: "SEND_MESSAGE"; text: string }
  | { type: "TEXT_DELTA"; text: string }
  | { type: "REASONING_DELTA"; text: string }
  | { type: "REASONING_SIGNATURE"; signature: string }
  | { type: "REASONING_REDACTED" }
  | { type: "STEP_START"; index: number; stepType: string }
  | { type: "STEP_FINISH"; index: number; finishReason: string }
  | { type: "TOOL_CALL"; id: string; name: string; args: unknown }
  | { type: "TOOL_RESULT"; id: string; result: unknown }
  | { type: "STREAM_DONE" }
  | { type: "STREAM_ERROR"; error: string }
  | { type: "LOAD_CONVERSATION"; messages: ConversationMessage[]; conversationId: string; instanceSlug?: string }
  | { type: "NEW_CHAT" }
  | { type: "SET_INSTANCE"; slug: string };

// ── Reducer ─────────────────────────────────────────────────────────

function generateId(): string {
  return crypto.randomUUID();
}

export function createInitialState(instanceSlug: string): ChatState {
  return {
    messages: [],
    isStreaming: false,
    error: null,
    chatId: generateId(),
    conversationId: null,
    instanceSlug,
  };
}

/** Helper: replace the trailing assistant message via a transformer. */
function updateLastAssistant(
  messages: ChatMessage[],
  fn: (msg: ChatMessage) => ChatMessage,
): ChatMessage[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (last.role !== "assistant" || !last.isStreaming) return messages;
  return [...messages.slice(0, -1), fn(last)];
}

/** Map a persisted StepDetail to the live shape (no in-flight state). */
function liveStepFromPersisted(s: StepDetail): LiveStep {
  return {
    index: s.index,
    stepType: s.stepType,
    text: s.text,
    toolCalls: s.toolCalls,
    toolResults: s.toolResults ?? [],
    finishReason: s.finishReason,
    done: true,
  };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "SEND_MESSAGE": {
      const now = new Date().toISOString();
      const userMsg: ChatMessage = {
        id: generateId(),
        role: "user",
        content: action.text,
        steps: [],
        reasoning: [],
        isStreaming: false,
        createdAt: now,
      };
      const assistantMsg: ChatMessage = {
        id: generateId(),
        role: "assistant",
        content: "",
        steps: [],
        reasoning: [],
        isStreaming: true,
        createdAt: null,
      };
      return {
        ...state,
        messages: [...state.messages, userMsg, assistantMsg],
        isStreaming: true,
        error: null,
      };
    }

    case "TEXT_DELTA": {
      return {
        ...state,
        messages: updateLastAssistant(state.messages, (m) => ({
          ...m,
          content: m.content + action.text,
        })),
      };
    }

    case "REASONING_DELTA": {
      return {
        ...state,
        messages: updateLastAssistant(state.messages, (m) => {
          // Append text into the last open text-block, or start a new one.
          const lastReasoning = m.reasoning[m.reasoning.length - 1];
          if (lastReasoning?.type === "text" && !lastReasoning.signature) {
            const updated: ReasoningDetail = {
              ...lastReasoning,
              text: lastReasoning.text + action.text,
            };
            return { ...m, reasoning: [...m.reasoning.slice(0, -1), updated] };
          }
          return {
            ...m,
            reasoning: [...m.reasoning, { type: "text", text: action.text }],
          };
        }),
      };
    }

    case "REASONING_SIGNATURE": {
      return {
        ...state,
        messages: updateLastAssistant(state.messages, (m) => {
          const lastReasoning = m.reasoning[m.reasoning.length - 1];
          if (!lastReasoning || lastReasoning.type !== "text") return m;
          return {
            ...m,
            reasoning: [
              ...m.reasoning.slice(0, -1),
              { ...lastReasoning, signature: action.signature },
            ],
          };
        }),
      };
    }

    case "REASONING_REDACTED": {
      return {
        ...state,
        messages: updateLastAssistant(state.messages, (m) => ({
          ...m,
          reasoning: [...m.reasoning, { type: "redacted", data: "" }],
        })),
      };
    }

    case "STEP_START": {
      return {
        ...state,
        messages: updateLastAssistant(state.messages, (m) => {
          // Reuse an existing step row for this index (idempotent).
          if (m.steps.some((s) => s.index === action.index)) return m;
          return {
            ...m,
            steps: [
              ...m.steps,
              {
                index: action.index,
                stepType: action.stepType,
                text: "",
                toolCalls: [],
                toolResults: [],
                done: false,
              },
            ],
          };
        }),
      };
    }

    case "STEP_FINISH": {
      return {
        ...state,
        messages: updateLastAssistant(state.messages, (m) => ({
          ...m,
          steps: m.steps.map((s) =>
            s.index === action.index
              ? { ...s, finishReason: action.finishReason, done: true }
              : s,
          ),
        })),
      };
    }

    case "TOOL_CALL": {
      return {
        ...state,
        messages: updateLastAssistant(state.messages, (m) => {
          const steps = [...m.steps];
          // Attach to the most recent open step (or last step in any case).
          const idx = steps.length - 1;
          if (idx < 0) return m;
          steps[idx] = {
            ...steps[idx],
            toolCalls: [
              ...steps[idx].toolCalls,
              { toolCallId: action.id, toolName: action.name, args: action.args },
            ],
          };
          return { ...m, steps };
        }),
      };
    }

    case "TOOL_RESULT": {
      return {
        ...state,
        messages: updateLastAssistant(state.messages, (m) => {
          // Pin the result on whichever step holds the matching toolCallId.
          const steps = m.steps.map((s) => {
            if (s.toolCalls.some((tc) => tc.toolCallId === action.id)) {
              return {
                ...s,
                toolResults: [...s.toolResults, { toolCallId: action.id, result: action.result }],
              };
            }
            return s;
          });
          return { ...m, steps };
        }),
      };
    }

    case "STREAM_DONE": {
      const now = new Date().toISOString();
      const msgs = state.messages.map((msg) =>
        msg.isStreaming ? { ...msg, isStreaming: false, createdAt: now } : msg,
      );
      return { ...state, messages: msgs, isStreaming: false };
    }

    case "STREAM_ERROR": {
      const msgs = state.messages.map((msg) =>
        msg.isStreaming ? { ...msg, isStreaming: false } : msg,
      );
      return {
        ...state,
        messages: msgs,
        isStreaming: false,
        error: action.error,
      };
    }

    case "LOAD_CONVERSATION": {
      const loaded: ChatMessage[] = action.messages.map((msg) => ({
        id: msg.id,
        role: msg.role as "user" | "assistant" | "system",
        content: msg.content,
        steps: (msg.steps ?? []).map(liveStepFromPersisted),
        reasoning: msg.reasoning ?? [],
        isStreaming: false,
        createdAt: msg.createdAt ?? null,
      }));
      // Extract chatId from conversationId (format: api-{uuid})
      const chatId = action.conversationId.startsWith("api-")
        ? action.conversationId.slice(4)
        : action.conversationId;
      return {
        ...state,
        messages: loaded,
        conversationId: action.conversationId,
        chatId,
        // Set instanceSlug if provided (from conversation metadata)
        instanceSlug: action.instanceSlug ?? state.instanceSlug,
        isStreaming: false,
        error: null,
      };
    }

    case "NEW_CHAT":
      return {
        ...state,
        messages: [],
        chatId: generateId(),
        conversationId: null,
        isStreaming: false,
        error: null,
      };

    case "SET_INSTANCE":
      return {
        ...state,
        instanceSlug: action.slug,
        messages: [],
        chatId: generateId(),
        conversationId: null,
        isStreaming: false,
        error: null,
      };

    default:
      return state;
  }
}

// ── Hook ────────────────────────────────────────────────────────────

export function useChat(defaultInstanceSlug: string) {
  const [state, dispatch] = useReducer(
    chatReducer,
    defaultInstanceSlug,
    createInitialState,
  );
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(
    (text: string, authToken?: string) => {
      if (!text.trim() || state.isStreaming || !state.instanceSlug) return;

      dispatch({ type: "SEND_MESSAGE", text });

      // Build message history for the API
      const history: SSEMessage[] = state.messages
        .filter((m) => m.content.trim())
        .map((m) => ({ role: m.role, content: m.content }));
      history.push({ role: "user", content: text });

      const controller = new AbortController();
      abortRef.current = controller;

      streamChatCompletion(
        {
          instanceSlug: state.instanceSlug,
          messages: history,
          chatId: state.chatId,
          signal: controller.signal,
          authToken,
        },
        {
          onTextDelta: (text) => dispatch({ type: "TEXT_DELTA", text }),
          onReasoningDelta: (text) => dispatch({ type: "REASONING_DELTA", text }),
          onReasoningSignature: (signature) =>
            dispatch({ type: "REASONING_SIGNATURE", signature }),
          onReasoningRedacted: () => dispatch({ type: "REASONING_REDACTED" }),
          onStepStart: (index, stepType) =>
            dispatch({ type: "STEP_START", index, stepType }),
          onStepFinish: (index, finishReason) =>
            dispatch({ type: "STEP_FINISH", index, finishReason }),
          onToolCall: (id, name, args) =>
            dispatch({ type: "TOOL_CALL", id, name, args }),
          onToolResult: (id, result) =>
            dispatch({ type: "TOOL_RESULT", id, result }),
          onDone: () => {
            dispatch({ type: "STREAM_DONE" });
            abortRef.current = null;
          },
          onError: (error) => {
            dispatch({ type: "STREAM_ERROR", error: error.message });
            abortRef.current = null;
          },
        },
      );
    },
    [state.isStreaming, state.instanceSlug, state.messages, state.chatId],
  );

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    dispatch({ type: "STREAM_DONE" });
  }, []);

  const newChat = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    dispatch({ type: "NEW_CHAT" });
  }, []);

  const loadConversation = useCallback(async (conversationId: string, instanceSlug?: string) => {
    abortRef.current?.abort();
    abortRef.current = null;
    try {
      // Derive the instance scope from the explicit arg, or fall back to
      // parsing the conversation id (`<instanceSlug>:<channel>:<id>`).
      const scope = instanceSlug ?? conversationId.split(":")[0] ?? "";
      const result = await api.conversations.messages(conversationId, scope, {
        limit: 100,
      });
      dispatch({
        type: "LOAD_CONVERSATION",
        messages: result.messages,
        conversationId,
        instanceSlug,
      });
    } catch {
      dispatch({
        type: "STREAM_ERROR",
        error: "Failed to load conversation",
      });
    }
  }, []);

  const setInstance = useCallback((slug: string) => {
    abortRef.current?.abort();
    abortRef.current = null;
    dispatch({ type: "SET_INSTANCE", slug });
  }, []);

  return {
    state,
    sendMessage,
    stopStreaming,
    newChat,
    loadConversation,
    setInstance,
  };
}
