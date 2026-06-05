// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import {
  asInstanceSlug,
  asInstanceUuid,
  type InstanceSlug,
  type InstanceUuid,
} from "./identifiers.js";

describe("instance identifiers", () => {
  it("asInstanceSlug returns the input unchanged at runtime", () => {
    expect(asInstanceSlug("my-assistant")).toBe("my-assistant");
  });

  it("asInstanceUuid returns the input unchanged at runtime", () => {
    expect(asInstanceUuid("3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071")).toBe(
      "3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071",
    );
  });

  it("brands are type-incompatible (compile-time)", () => {
    const slug: InstanceSlug = asInstanceSlug("x");
    const uuid: InstanceUuid = asInstanceUuid("y");
    // @ts-expect-error a plain string is not assignable to InstanceSlug
    const _bad1: InstanceSlug = "plain";
    // @ts-expect-error InstanceUuid is not assignable to InstanceSlug
    const _bad2: InstanceSlug = uuid;
    expect(slug).not.toBe(uuid);
    void _bad1;
    void _bad2;
  });
});
