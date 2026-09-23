// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import { modelSupportsVision, sanitizeMessagesForModel } from "./vision.js";

describe("modelSupportsVision", () => {
  it.each([
    ["openai", "gpt-4o", true],
    ["openai", "gpt-4o-mini", true],
    ["openai", "o3", true],
    ["bedrock", "eu.anthropic.claude-sonnet-4-6", true],
    ["bedrock", "eu.amazon.nova-lite-v1:0", true],
    ["bedrock", "eu.amazon.nova-pro-v1:0", true],
    ["bedrock", "eu.amazon.nova-2-lite-v1:0", true],
    ["bedrock", "qwen.qwen3-235b-a22b-2507-v1:0", false],
    ["bedrock", "openai.gpt-oss-120b-1:0", false],
    ["bedrock", "eu.amazon.nova-micro-v1:0", false],
    // Un-catalogued ids fall through to the logged id heuristic.
    ["bedrock", "deepseek.r1-v1:0", false],
    ["bedrock", "mistral.mistral-large-2407-v1:0", false],
  ])("%s/%s -> %s", (provider, model, expected) => {
    expect(modelSupportsVision(provider, model)).toBe(expected);
  });
});

const BEDROCK = "bedrock";
const QWEN = "qwen.qwen3-235b-a22b-2507-v1:0";
const NOVA = "eu.amazon.nova-lite-v1:0";

describe("sanitizeMessagesForModel — vision strip", () => {
  const withImage: ModelMessage[] = [
    { role: "user", content: [{ type: "text", text: "ecco" }, { type: "image", image: new Uint8Array([1]), mediaType: "image/jpeg" }] },
  ] as never;

  it("replaces image parts with a text note for text-only models", () => {
    const parts = sanitizeMessagesForModel(withImage, BEDROCK, QWEN)[0].content as Array<{ type: string; text?: string }>;
    expect(parts.some((p) => p.type === "image")).toBe(false);
    expect(parts.find((p) => p.type === "text" && p.text?.includes("attachment"))).toBeTruthy();
  });

  it("leaves messages untouched (same ref) for vision-capable models when nothing blank", () => {
    expect(sanitizeMessagesForModel(withImage, BEDROCK, NOVA)).toBe(withImage);
  });
});

describe("sanitizeMessagesForModel — blank text (Bedrock strictness)", () => {
  it("drops a blank text part but keeps the image (vision model)", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "" }, { type: "image", image: new Uint8Array([1]), mediaType: "image/jpeg" }] },
    ] as never;
    const parts = sanitizeMessagesForModel(msgs, BEDROCK, NOVA)[0].content as Array<{ type: string; text?: string }>;
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("image");
  });

  it("drops blank text and keeps non-blank text", () => {
    const msgs: ModelMessage[] = [{ role: "assistant", content: [{ type: "text", text: "  " }, { type: "text", text: "ok" }] }] as never;
    const parts = sanitizeMessagesForModel(msgs, BEDROCK, QWEN)[0].content as Array<{ type: string; text?: string }>;
    expect(parts).toHaveLength(1);
    expect(parts[0].text).toBe("ok");
  });

  it("backfills a placeholder when array content becomes empty", () => {
    const msgs: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "" }] }] as never;
    const parts = sanitizeMessagesForModel(msgs, BEDROCK, NOVA)[0].content as Array<{ type: string; text?: string }>;
    expect(parts).toHaveLength(1);
    expect(parts[0].text).toBe("[attachment]");
  });

  it("backfills a placeholder for empty string content", () => {
    const msgs: ModelMessage[] = [{ role: "user", content: "" }] as never;
    expect(sanitizeMessagesForModel(msgs, BEDROCK, NOVA)[0].content).toBe("[attachment]");
  });

  it("leaves a normal string message untouched (same ref)", () => {
    const msgs: ModelMessage[] = [{ role: "user", content: "ciao" }] as never;
    expect(sanitizeMessagesForModel(msgs, BEDROCK, QWEN)).toBe(msgs);
  });
});

describe("sanitizeMessagesForModel — tool wire identifiers", () => {
  it("normalizes invalid tool names and call ids in pre-built tool messages", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Controllo." },
          {
            type: "tool-call",
            toolCallId: "hook:run/42",
            toolName: "innova:valida.richiámata",
            input: { phone: "+39 123" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "hook:run/42",
            toolName: "innova:valida.richiámata",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ] as never;

    const sanitized = sanitizeMessagesForModel(messages, BEDROCK, NOVA);
    const toolCall = (sanitized[0].content as Array<Record<string, unknown>>)[1];
    const toolResult = (sanitized[1].content as Array<Record<string, unknown>>)[0];

    expect(sanitized).not.toBe(messages);
    expect(toolCall).toMatchObject({
      toolCallId: "hook_run_42",
      toolName: "innova__valida_richi_mata",
      input: { phone: "+39 123" },
    });
    expect(toolResult).toMatchObject({
      toolCallId: "hook_run_42",
      toolName: "innova__valida_richi_mata",
      output: { type: "text", value: "ok" },
    });
  });
});
