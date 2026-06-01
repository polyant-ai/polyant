// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";

import { createDefinitionSchema, updateDefinitionSchema } from "./webhook.validators.js";

describe("createDefinitionSchema", () => {
  const baseFields = {
    name: "test-definition",
    matchingPrompt: "match anything",
  };

  it("accepts action='conversation' without outboundChannel (internal mode)", () => {
    const result = createDefinitionSchema.safeParse({
      ...baseFields,
      action: "conversation",
      contextPrompt: "Do the thing",
    });
    expect(result.success).toBe(true);
  });

  it("accepts action='conversation' with both outboundChannel and outboundTarget", () => {
    const result = createDefinitionSchema.safeParse({
      ...baseFields,
      action: "conversation",
      contextPrompt: "Reply to the user",
      outboundChannel: "telegram",
      outboundTarget: "{{payload.chat_id}}",
    });
    expect(result.success).toBe(true);
  });

  it("rejects action='conversation' without contextPrompt", () => {
    const result = createDefinitionSchema.safeParse({
      ...baseFields,
      action: "conversation",
    });
    expect(result.success).toBe(false);
  });

  it("rejects outboundChannel without outboundTarget", () => {
    const result = createDefinitionSchema.safeParse({
      ...baseFields,
      action: "conversation",
      contextPrompt: "Reply",
      outboundChannel: "telegram",
    });
    expect(result.success).toBe(false);
  });

  it("rejects outboundTarget without outboundChannel", () => {
    const result = createDefinitionSchema.safeParse({
      ...baseFields,
      action: "conversation",
      contextPrompt: "Reply",
      outboundTarget: "+14155550100",
    });
    expect(result.success).toBe(false);
  });

  it("accepts action='backlog' with interpretationPrompt", () => {
    const result = createDefinitionSchema.safeParse({
      ...baseFields,
      action: "backlog",
      interpretationPrompt: "Summarise the event",
    });
    expect(result.success).toBe(true);
  });

  it("rejects action='backlog' without interpretationPrompt", () => {
    const result = createDefinitionSchema.safeParse({
      ...baseFields,
      action: "backlog",
      interpretationPrompt: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("updateDefinitionSchema", () => {
  it("accepts patch that only touches outboundChannel", () => {
    const result = updateDefinitionSchema.safeParse({ outboundChannel: "slack" });
    expect(result.success).toBe(true);
  });

  it("accepts patch that nulls both outboundChannel and outboundTarget", () => {
    const result = updateDefinitionSchema.safeParse({
      outboundChannel: null,
      outboundTarget: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts patch that sets both outboundChannel and outboundTarget", () => {
    const result = updateDefinitionSchema.safeParse({
      outboundChannel: "whatsapp",
      outboundTarget: "+14155550100",
    });
    expect(result.success).toBe(true);
  });

  it("rejects patch that sets outboundChannel but explicitly nulls outboundTarget", () => {
    const result = updateDefinitionSchema.safeParse({
      outboundChannel: "telegram",
      outboundTarget: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects patch that sets outboundTarget but explicitly nulls outboundChannel", () => {
    const result = updateDefinitionSchema.safeParse({
      outboundChannel: null,
      outboundTarget: "+14155550100",
    });
    expect(result.success).toBe(false);
  });
});
