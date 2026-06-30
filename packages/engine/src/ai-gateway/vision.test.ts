// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import { modelSupportsVision, sanitizeMessagesForModel } from "./vision.js";

describe("modelSupportsVision", () => {
  it("true for vision-capable models", () => {
    for (const m of ["gpt-4o", "gpt-4o-mini", "o3", "eu.anthropic.claude-sonnet-4-6", "eu.amazon.nova-lite-v1:0", "eu.amazon.nova-pro-v1:0", "eu.amazon.nova-2-lite-v1:0"])
      expect(modelSupportsVision(m)).toBe(true);
  });
  it("false for text-only models", () => {
    for (const m of ["qwen.qwen3-235b-a22b-2507-v1:0", "openai.gpt-oss-120b-1:0", "eu.amazon.nova-micro-v1:0", "deepseek.r1-v1:0", "mistral.mistral-large-2407-v1:0"])
      expect(modelSupportsVision(m)).toBe(false);
  });
});

const QWEN = "qwen.qwen3-235b-a22b-2507-v1:0";
const NOVA = "eu.amazon.nova-lite-v1:0";

describe("sanitizeMessagesForModel — vision strip", () => {
  const withImage: ModelMessage[] = [
    { role: "user", content: [{ type: "text", text: "ecco" }, { type: "image", image: new Uint8Array([1]), mediaType: "image/jpeg" }] },
  ] as never;

  it("replaces image parts with a text note for text-only models", () => {
    const parts = sanitizeMessagesForModel(withImage, QWEN)[0].content as Array<{ type: string; text?: string }>;
    expect(parts.some((p) => p.type === "image")).toBe(false);
    expect(parts.find((p) => p.type === "text" && p.text?.includes("attachment"))).toBeTruthy();
  });

  it("leaves messages untouched (same ref) for vision-capable models when nothing blank", () => {
    expect(sanitizeMessagesForModel(withImage, NOVA)).toBe(withImage);
  });
});

describe("sanitizeMessagesForModel — blank text (Bedrock strictness)", () => {
  it("drops a blank text part but keeps the image (vision model)", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "" }, { type: "image", image: new Uint8Array([1]), mediaType: "image/jpeg" }] },
    ] as never;
    const parts = sanitizeMessagesForModel(msgs, NOVA)[0].content as Array<{ type: string; text?: string }>;
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("image");
  });

  it("drops blank text and keeps non-blank text", () => {
    const msgs: ModelMessage[] = [{ role: "assistant", content: [{ type: "text", text: "  " }, { type: "text", text: "ok" }] }] as never;
    const parts = sanitizeMessagesForModel(msgs, QWEN)[0].content as Array<{ type: string; text?: string }>;
    expect(parts).toHaveLength(1);
    expect(parts[0].text).toBe("ok");
  });

  it("backfills a placeholder when array content becomes empty", () => {
    const msgs: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "" }] }] as never;
    const parts = sanitizeMessagesForModel(msgs, NOVA)[0].content as Array<{ type: string; text?: string }>;
    expect(parts).toHaveLength(1);
    expect(parts[0].text).toBe("[attachment]");
  });

  it("backfills a placeholder for empty string content", () => {
    const msgs: ModelMessage[] = [{ role: "user", content: "" }] as never;
    expect(sanitizeMessagesForModel(msgs, NOVA)[0].content).toBe("[attachment]");
  });

  it("leaves a normal string message untouched (same ref)", () => {
    const msgs: ModelMessage[] = [{ role: "user", content: "ciao" }] as never;
    expect(sanitizeMessagesForModel(msgs, QWEN)).toBe(msgs);
  });
});
