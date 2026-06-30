// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import { modelSupportsVision, stripVisionForModel } from "./vision.js";

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

describe("stripVisionForModel", () => {
  const withImage: ModelMessage[] = [
    { role: "user", content: [{ type: "text", text: "ecco" }, { type: "image", image: new Uint8Array([1]), mediaType: "image/jpeg" }] },
  ] as never;

  it("replaces image parts with a text note for text-only models", () => {
    const out = stripVisionForModel(withImage, "qwen.qwen3-235b-a22b-2507-v1:0");
    const parts = out[0].content as Array<{ type: string; text?: string }>;
    expect(parts.some((p) => p.type === "image")).toBe(false);
    expect(parts.find((p) => p.type === "text" && p.text?.includes("allegato"))).toBeTruthy();
  });

  it("leaves messages untouched (same ref) for vision-capable models", () => {
    expect(stripVisionForModel(withImage, "eu.amazon.nova-lite-v1:0")).toBe(withImage);
  });

  it("passes through string content untouched", () => {
    const msgs: ModelMessage[] = [{ role: "user", content: "ciao" }] as never;
    expect(stripVisionForModel(msgs, "qwen")).toEqual(msgs);
  });
});
