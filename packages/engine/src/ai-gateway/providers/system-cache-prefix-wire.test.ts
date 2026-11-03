// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { jsonSchema, tool, type ModelMessage } from "ai";
import { AnthropicProvider } from "./anthropic.js";
import { BedrockProvider } from "./bedrock.js";
import { OpenAIProvider } from "./openai.js";
import { NebiusProvider } from "./nebius.js";
import type { ChatRequest } from "../types.js";

// The real provider SDKs serialize the request; only the network is stubbed and
// the assertions read the body that would have been sent. The property under
// test: the cache breakpoint on the agent's system prompt covers only text that
// is identical for every conversation of the agent. System text that belongs
// to one conversation (a hook's one-shot context, a persisted system row) must
// sit after that breakpoint, or every new conversation rewrites the whole
// tools + system prefix instead of reading it.

const AGENT_SYSTEM = "You are the assistant of a generic service.\n\n---\n\n## Rules\n\nAnswer briefly.";
const TOOLS = {
  lookup: tool({
    description: "Look up a record by reference.",
    inputSchema: jsonSchema({ type: "object", properties: { ref: { type: "string" } }, required: ["ref"], additionalProperties: false }),
  }),
};

let sentBodies: Record<string, unknown>[] = [];

function fakeResponseFor(url: string): unknown {
  if (url.includes("anthropic.com")) {
    return {
      id: "msg_1", type: "message", role: "assistant", model: "claude", content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
    };
  }
  if (url.includes("bedrock")) {
    return {
      output: { message: { role: "assistant", content: [{ text: "ok" }] } }, stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, metrics: { latencyMs: 1 },
    };
  }
  if (url.endsWith("/responses")) {
    return {
      id: "resp_1", object: "response", created_at: 0, status: "completed", model: "m",
      output: [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }
  return {
    id: "c1", object: "chat.completion", created: 0, model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

beforeEach(() => {
  sentBodies = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    sentBodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(fakeResponseFor(url)), { status: 200, headers: { "content-type": "application/json" } });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A first contact: the agent's system prompt, then one conversation's own system text, then the user's message. */
function firstContact(conversationSystemText: string[]): ModelMessage[] {
  return [
    ...conversationSystemText.map((content): ModelMessage => ({ role: "system", content })),
    { role: "user", content: "Hello" },
  ];
}

async function send(
  provider: typeof AnthropicProvider,
  modelId: string,
  apiKeys: ChatRequest["apiKeys"],
  messages: ModelMessage[],
): Promise<Record<string, unknown>> {
  const before = sentBodies.length;
  await provider.chat({ tier: "standard", system: AGENT_SYSTEM, messages, tools: TOOLS, maxSteps: 1, apiKeys }, modelId);
  expect(sentBodies.length).toBe(before + 1);
  return sentBodies[before];
}

/**
 * The request in the order the provider reads it for caching (tools, then
 * system, then messages), one entry per block, each flagged when a cache
 * breakpoint closes it. The marker itself is left out of the compared bytes.
 */
type Segment = { label: string; bytes: string; breakpoint: boolean };

function anthropicSegments(body: Record<string, unknown>): Segment[] {
  const out: Segment[] = [];
  const push = (label: string, block: Record<string, unknown>) => {
    const { cache_control, ...rest } = block;
    out.push({ label, bytes: JSON.stringify(rest), breakpoint: cache_control !== undefined });
  };
  for (const t of (body.tools ?? []) as Record<string, unknown>[]) push(`tool:${String(t.name)}`, t);
  ((body.system ?? []) as Record<string, unknown>[]).forEach((b, i) => push(`system[${i}]`, b));
  ((body.messages ?? []) as { role: string; content: Record<string, unknown>[] }[]).forEach((m, i) =>
    m.content.forEach((p, j) => push(`messages[${i}].${m.role}[${j}]`, p)),
  );
  return out;
}

function bedrockSegments(body: Record<string, unknown>): Segment[] {
  const out: Segment[] = [];
  const walk = (label: string, blocks: Record<string, unknown>[]) =>
    blocks.forEach((b, i) => {
      if (b.cachePoint) {
        if (out.length > 0) out[out.length - 1].breakpoint = true;
        return;
      }
      out.push({ label: `${label}[${i}]`, bytes: JSON.stringify(b), breakpoint: false });
    });
  const toolConfig = body.toolConfig as { tools?: Record<string, unknown>[] } | undefined;
  walk("tools", toolConfig?.tools ?? []);
  walk("system", (body.system ?? []) as Record<string, unknown>[]);
  ((body.messages ?? []) as { role: string; content: Record<string, unknown>[] }[]).forEach((m, i) =>
    walk(`messages[${i}].${m.role}`, m.content),
  );
  return out;
}

/** Where two requests first differ, and whether a cache breakpoint closed the prefix before that point. */
function firstDifference(a: Segment[], b: Segment[]): { label: string; cachedPrefixIntact: boolean } {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i].bytes !== b[i].bytes) {
      return { label: a[i].label, cachedPrefixIntact: a.slice(0, i).some((s) => s.breakpoint) };
    }
  }
  throw new Error("the two requests are identical");
}

const INJECTED_A = "[OPENING] Greet the caller as Ada.";
const INJECTED_B = "[OPENING] Greet the caller as Bruno.";

describe("conversation system text and the cached tools + system prefix", () => {
  it("Anthropic: two conversations with different injected text share the cached prefix", async () => {
    const keys = { anthropic: "test" };
    const a = anthropicSegments(await send(AnthropicProvider, "claude-sonnet-4-6", keys, firstContact([INJECTED_A])));
    const b = anthropicSegments(await send(AnthropicProvider, "claude-sonnet-4-6", keys, firstContact([INJECTED_B])));

    const diff = firstDifference(a, b);
    expect(diff.cachedPrefixIntact).toBe(true);
    // The marked block is exactly the agent's system prompt.
    const marked = a.filter((s) => s.label.startsWith("system") && s.breakpoint);
    expect(marked.map((s) => JSON.parse(s.bytes).text)).toEqual([AGENT_SYSTEM]);
    // The injected text still reaches the model, in a system block after it.
    expect(a.some((s) => s.label.startsWith("system") && JSON.parse(s.bytes).text === INJECTED_A)).toBe(true);
  });

  it("Bedrock: two conversations with different injected text share the cached prefix", async () => {
    const keys = { bedrock_api_key: "test", bedrock_region: "eu-west-1" };
    const model = "eu.anthropic.claude-sonnet-4-6";
    const a = bedrockSegments(await send(BedrockProvider, model, keys, firstContact([INJECTED_A])));
    const b = bedrockSegments(await send(BedrockProvider, model, keys, firstContact([INJECTED_B])));

    const diff = firstDifference(a, b);
    expect(diff.cachedPrefixIntact).toBe(true);
    const marked = a.filter((s) => s.label.startsWith("system") && s.breakpoint);
    expect(marked.map((s) => JSON.parse(s.bytes).text)).toEqual([AGENT_SYSTEM]);
    expect(a.some((s) => s.label.startsWith("system") && JSON.parse(s.bytes).text === INJECTED_A)).toBe(true);
  });

  it("Bedrock without cache support: one plain system text, unchanged", async () => {
    const keys = { bedrock_api_key: "test", bedrock_region: "eu-west-1" };
    const body = await send(BedrockProvider, "qwen.qwen3-32b-v1:0", keys, firstContact([INJECTED_A]));
    expect(body.system).toEqual([{ text: `${AGENT_SYSTEM}\n\n${INJECTED_A}` }]);
  });
});

describe("providers without cache markers receive the same system text as before", () => {
  const PERSISTED = "## Trigger context\n\nOrder 42 shipped.";
  const history: ModelMessage[] = [
    { role: "system", content: PERSISTED },
    { role: "user", content: "Where is my order?" },
    { role: "assistant", content: "On its way." },
    { role: "system", content: INJECTED_A },
    { role: "user", content: "Thanks" },
  ];
  const expected = `${AGENT_SYSTEM}\n\n${PERSISTED}\n\n${INJECTED_A}`;

  /** The text of every system/developer message in a chat-completions or responses body. */
  function systemTexts(body: Record<string, unknown>): unknown[] {
    const list = (body.messages ?? body.input ?? []) as { role: string; content: unknown }[];
    return list.filter((m) => m.role === "system" || m.role === "developer").map((m) => m.content);
  }

  it("OpenAI", async () => {
    const body = await send(OpenAIProvider, "gpt-4.1", { openai: "test" }, history);
    expect(systemTexts(body)).toEqual([expected]);
  });

  it("OpenAI-compatible", async () => {
    const body = await send(NebiusProvider, "Qwen/Qwen3-32B", { nebius: "test" }, history);
    expect(systemTexts(body)).toEqual([expected]);
  });
});
