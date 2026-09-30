// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { buildAnthropicThinkingOffOptions } from "./anthropic.js";
import { reasoningOffFor } from "../config.js";

// The gateway test proves `providerOptions.anthropic.thinking` is
// `between_tools` for Sonnet 5.5 with thinking off; this one proves it reaches
// the wire. The engine resolves its own `@ai-sdk/anthropic` (nested, ≥ 4.0.68)
// next to the 4.0.58 copy Bedrock pins, and an older SDK drops or rejects the
// value — which would leave Sonnet 5.5 on its default adaptive thinking: a
// reasoning pass before every answer and the text streamed in one block.
async function sentBody(modelId: string): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | undefined;
  const fakeFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    body = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: modelId,
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const model = createAnthropic({ apiKey: "test", fetch: fakeFetch })(modelId);
  await generateText({
    model,
    prompt: "hi",
    providerOptions: { anthropic: buildAnthropicThinkingOffOptions(reasoningOffFor("anthropic", modelId)) },
  });
  if (!body) throw new Error("no request sent");
  return body;
}

describe("Anthropic thinking off on the wire", () => {
  it("sends thinking between_tools and no effort for claude-sonnet-5-5", async () => {
    const body = await sentBody("claude-sonnet-5-5");
    expect(body.thinking).toEqual({ type: "between_tools" });
    expect((body.output_config as { effort?: string } | undefined)?.effort).toBeUndefined();
  });

  it("sends thinking disabled for claude-sonnet-5", async () => {
    const body = await sentBody("claude-sonnet-5");
    expect(body.thinking).toEqual({ type: "disabled" });
  });
});
