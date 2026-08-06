// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

import { asInstanceSlug } from "../../instances/identifiers.js";

vi.mock("../../instances/store.js", () => ({
  findInstanceBySlug: vi.fn(async () => ({
    id: "u1", slug: "acme", name: "Acme", description: "d", authEnabled: false,
  })),
}));

import { findInstanceBySlug } from "../../instances/store.js";
import { A2aHandlerRegistry } from "./a2a-handler.registry.js";

const fakeStreamHandler = (async () => ({
  textStream: (async function* () {})(),
  fullStream: (async function* () {})(),
  completed: Promise.resolve({ text: "" }),
})) as never;

describe("A2aHandlerRegistry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should_build_a_handler_and_cache_it_per_slug", async () => {
    const reg = new A2aHandlerRegistry();
    reg.setStreamMessageHandler(fakeStreamHandler);
    const h1 = await reg.getHandler(asInstanceSlug("acme"));
    const h2 = await reg.getHandler(asInstanceSlug("acme"));
    expect(h1).toBe(h2); // cached — same instance
    expect(findInstanceBySlug).toHaveBeenCalledTimes(1); // built once
  });

  it("should_throw_when_the_instance_is_missing", async () => {
    (findInstanceBySlug as any).mockResolvedValueOnce(undefined);
    const reg = new A2aHandlerRegistry();
    reg.setStreamMessageHandler(fakeStreamHandler);
    await expect(reg.getHandler(asInstanceSlug("ghost"))).rejects.toThrow();
  });

  it("should_throw_when_the_stream_handler_is_not_set", async () => {
    const reg = new A2aHandlerRegistry();
    await expect(reg.getHandler(asInstanceSlug("acme"))).rejects.toThrow();
  });
});
