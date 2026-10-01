// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { buildOpenAIReasoningOffOptions, buildOpenAIReasoningOptions } from "./openai.js";

// The gateway test proves `providerOptions.openai.reasoningEffort` is `none` for
// gpt-6 sol/luna with thinking off; this one proves it reaches the wire. The SDK
// keeps its own per-model list of accepted efforts and drops anything outside it
// with only a warning: before @ai-sdk/openai 4.0.73 that list had no `none` for
// gpt-6, so the request went out with no `reasoning` at all and the model ran at
// its default effort, `medium` — thinking through every turn switched off.
async function sentBody(modelId: string, providerOptions: { reasoningEffort: string }): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | undefined;
  const fakeFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    body = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        id: "resp_test",
        object: "response",
        created_at: 0,
        status: "completed",
        model: modelId,
        output: [
          {
            type: "message",
            id: "msg_test",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "ok", annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const model = createOpenAI({ apiKey: "test", fetch: fakeFetch }).responses(modelId);
  await generateText({ model, prompt: "hi", providerOptions: { openai: providerOptions } });
  if (!body) throw new Error("no request sent");
  return body;
}

describe("OpenAI reasoning effort on the wire", () => {
  it.each(["gpt-6-luna", "gpt-6-sol"])("sends reasoning.effort none for %s with thinking off", async (modelId) => {
    const body = await sentBody(modelId, buildOpenAIReasoningOffOptions());
    expect((body.reasoning as { effort?: string } | undefined)?.effort).toBe("none");
  });

  it("sends the requested level for gpt-6-luna with thinking on", async () => {
    const body = await sentBody("gpt-6-luna", buildOpenAIReasoningOptions("low"));
    expect((body.reasoning as { effort?: string } | undefined)?.effort).toBe("low");
  });
});
