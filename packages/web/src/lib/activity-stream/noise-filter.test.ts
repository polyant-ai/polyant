// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { isNoiseEvent } from "./noise-filter";
import type { FeedEvent } from "@/lib/activity-stream/types";

const base: FeedEvent = {
  id: "x",
  ts: "2026-05-06T12:00:00Z",
  persona: "agent",
  text: "",
};

describe("isNoiseEvent", () => {
  it("drops assistant text events with empty body", () => {
    expect(isNoiseEvent({ ...base, persona: "agent", text: "" })).toBe(true);
    expect(isNoiseEvent({ ...base, persona: "agent", text: "«»" })).toBe(true);
    expect(isNoiseEvent({ ...base, persona: "agent", text: "[]" })).toBe(true);
    expect(isNoiseEvent({ ...base, persona: "agent", text: "{}" })).toBe(true);
    expect(isNoiseEvent({ ...base, persona: "agent", text: "  " })).toBe(true);
  });

  it("keeps assistant text events with meaningful body", () => {
    expect(isNoiseEvent({ ...base, persona: "agent", text: "Risposta finale" })).toBe(false);
  });

  it("keeps assistant text events with empty text but populated responsePreview", () => {
    expect(
      isNoiseEvent({
        ...base,
        persona: "agent",
        text: "",
        responsePreview: "Risposta finale al cliente",
      }),
    ).toBe(false);
  });

  it("always keeps tool events even with empty body", () => {
    expect(
      isNoiseEvent({
        ...base,
        persona: "agent",
        text: "",
        tool: { name: "searchKnowledge", summary: "" },
      }),
    ).toBe(false);
  });

  it("drops thinking events with no body", () => {
    expect(isNoiseEvent({ ...base, persona: "thinking", text: "" })).toBe(true);
    expect(isNoiseEvent({ ...base, persona: "thinking", text: "  " })).toBe(true);
  });

  it("keeps thinking events with reasoning text", () => {
    expect(
      isNoiseEvent({ ...base, persona: "thinking", text: "valuto la richiesta" }),
    ).toBe(false);
  });

  it("drops reply events whose body is pure JSON (memory extraction etc.)", () => {
    expect(
      isNoiseEvent({
        ...base,
        persona: "agent",
        text: "",
        responsePreview: '[{"content":"foo","category":"event","importance":5}]',
      }),
    ).toBe(true);
    expect(
      isNoiseEvent({
        ...base,
        persona: "agent",
        text: '[{"content":"foo"}]',
      }),
    ).toBe(true);
    expect(
      isNoiseEvent({
        ...base,
        persona: "agent",
        text: '   {"key": 42}   ',
      }),
    ).toBe(true);
  });

  it("does not drop replies that contain JSON inside prose", () => {
    expect(
      isNoiseEvent({
        ...base,
        persona: "agent",
        text: 'Risposta: ecco i dati [{"a":1}].',
      }),
    ).toBe(false);
  });

  it("does not drop tool events even when their result is JSON-shaped", () => {
    expect(
      isNoiseEvent({
        ...base,
        persona: "agent",
        text: '[{"id":1}]',
        tool: { name: "searchKnowledge", summary: "" },
      }),
    ).toBe(false);
  });
});
