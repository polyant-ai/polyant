// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { asInstanceSlug } from "../../instances/identifiers.js";

// The turn's preflight resolves the agent's configuration; doubled here, the real resolver opens a database connection.
vi.mock("../../instances/config-resolver.js", () => ({
  resolveInstanceConfig: vi.fn(async () => ({ providerRefusal: null, tierModels: {} })),
  invalidateInstanceConfigCache: vi.fn(),
}));

describe("wrapToolWithAudit — the channel's tool gate", () => {
  const wrap = async (toolGate: (name: string) => boolean, inner: { execute: ReturnType<typeof vi.fn> }) => {
    const { wrapToolWithAudit } = await import("./index.js");
    return wrapToolWithAudit("booking:create", inner as never, asInstanceSlug("agent"), "agent:whatsapp:1", [],
      { replyHandled: false, replyTexts: [], toolGate } as never);
  };

  it("does not run a tool the channel refuses, and tells the model it was not run", async () => {
    const inner = { execute: vi.fn().mockResolvedValue({ status: "booked" }) };
    const gate = vi.fn(() => false);
    const wrapped = await wrap(gate, inner);

    const result = await wrapped.execute!({ slot: "1" }, {} as never);

    expect(inner.execute).not.toHaveBeenCalled();
    expect(result).toEqual({ error: expect.stringContaining("Not run"), notRun: true });
    // Asked with the name the model knows the tool by.
    expect(gate).toHaveBeenCalledWith("booking__create");
  });

  it("runs the tool when the channel lets it", async () => {
    const inner = { execute: vi.fn().mockResolvedValue({ status: "booked" }) };
    const wrapped = await wrap(() => true, inner);

    await expect(wrapped.execute!({ slot: "1" }, {} as never)).resolves.toEqual({ status: "booked" });
    expect(inner.execute).toHaveBeenCalledTimes(1);
  });
});
