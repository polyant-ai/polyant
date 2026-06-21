// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import {
  asAgentSlug,
  asAgentUuid,
  type AgentSlug,
  type AgentUuid,
} from "./identifiers.js";

describe("instance identifiers", () => {
  it("asAgentSlug returns the input unchanged at runtime", () => {
    expect(asAgentSlug("my-assistant")).toBe("my-assistant");
  });

  it("asAgentUuid returns the input unchanged at runtime", () => {
    expect(asAgentUuid("3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071")).toBe(
      "3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071",
    );
  });

  it("brands are type-incompatible (compile-time)", () => {
    const slug: AgentSlug = asAgentSlug("x");
    const uuid: AgentUuid = asAgentUuid("y");
    // @ts-expect-error a plain string is not assignable to AgentSlug
    const _bad1: AgentSlug = "plain";
    // @ts-expect-error AgentUuid is not assignable to AgentSlug
    const _bad2: AgentSlug = uuid;
    expect(slug).not.toBe(uuid);
    void _bad1;
    void _bad2;
  });
});
