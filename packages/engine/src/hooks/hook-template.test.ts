// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderArgsTemplate } from "./hook-template.js";
import type { HookEventPayload } from "./hook-types.js";

const payload: HookEventPayload = {
  instance: { slug: "demo" },
  conversation: { id: "demo:whatsapp:+391234" },
  channel: { type: "whatsapp", id: "+391234" },
  user: { name: "Paolo" },
  message: { text: "ciao" },
  response: { text: "hello there" },
};

describe("renderArgsTemplate", () => {
  it("should_replace_placeholder_when_inside_string", () => {
    const { args, unresolved } = renderArgsTemplate(
      { query: "phone {{channel.id}}" },
      payload,
    );
    expect(args).toEqual({ query: "phone +391234" });
    expect(unresolved).toEqual([]);
  });

  it("should_replace_multiple_placeholders_in_one_string", () => {
    const { args } = renderArgsTemplate(
      { note: "{{user.name}} via {{channel.type}}" },
      payload,
    );
    expect(args).toEqual({ note: "Paolo via whatsapp" });
  });

  it("should_render_nested_objects_and_arrays", () => {
    const { args } = renderArgsTemplate(
      { filters: [{ value: "{{channel.id}}" }], meta: { conv: "{{conversation.id}}" } },
      payload,
    );
    expect(args).toEqual({
      filters: [{ value: "+391234" }],
      meta: { conv: "demo:whatsapp:+391234" },
    });
  });

  it("should_pass_through_non_string_values_verbatim", () => {
    const { args } = renderArgsTemplate(
      { limit: 5, active: true, nothing: null },
      payload,
    );
    expect(args).toEqual({ limit: 5, active: true, nothing: null });
  });

  it("should_render_empty_and_report_unresolved_when_path_missing", () => {
    const { args, unresolved } = renderArgsTemplate(
      { q: "x {{payload.bogus}} y" },
      payload,
    );
    expect(args).toEqual({ q: "x  y" });
    expect(unresolved).toEqual(["payload.bogus"]);
  });

  it("should_render_empty_when_response_absent", () => {
    const noResponse: HookEventPayload = { ...payload, response: undefined };
    const { args, unresolved } = renderArgsTemplate({ r: "{{response.text}}" }, noResponse);
    expect(args).toEqual({ r: "" });
    expect(unresolved).toEqual(["response.text"]);
  });
});
