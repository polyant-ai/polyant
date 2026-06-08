// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB-backed store so the buffer's in-memory logic is tested in isolation.
const { loadMock, flushMock } = vi.hoisted(() => ({
  loadMock: vi.fn(),
  flushMock: vi.fn(),
}));

vi.mock("./state.store.js", () => ({
  loadConversationState: loadMock,
  flushConversationState: flushMock,
}));

import {
  ConversationStateBuffer,
  CHANNEL_STATE_KEY,
  MAX_STATE_BYTES,
} from "./state.buffer.js";

describe("ConversationStateBuffer", () => {
  beforeEach(() => {
    loadMock.mockReset();
    flushMock.mockReset();
    loadMock.mockResolvedValue({});
    flushMock.mockResolvedValue(undefined);
  });

  it("should_return_set_value_when_get", () => {
    const buf = new ConversationStateBuffer("c1", "inst");
    buf.api().set("contactId", "123");
    expect(buf.api().get("contactId")).toBe("123");
  });

  it("should_read_prior_turn_values_from_initial_blob", () => {
    const buf = new ConversationStateBuffer("c1", "inst", { contactId: "abc" });
    expect(buf.api().get("contactId")).toBe("abc");
  });

  it("should_persist_only_dirty_keys_on_flush", async () => {
    const buf = new ConversationStateBuffer("c1", "inst", { existing: 1 });
    buf.api().set("contactId", "123");
    await buf.flush();
    expect(flushMock).toHaveBeenCalledWith("c1", "inst", { contactId: "123" }, []);
  });

  it("should_not_touch_store_when_nothing_changed", async () => {
    const buf = new ConversationStateBuffer("c1", "inst", { existing: 1 });
    await buf.flush();
    expect(flushMock).not.toHaveBeenCalled();
  });

  it("should_pass_deleted_keys_in_remove_on_flush", async () => {
    const buf = new ConversationStateBuffer("c1", "inst", { old: "x" });
    buf.api().delete("old");
    await buf.flush();
    expect(flushMock).toHaveBeenCalledWith("c1", "inst", {}, ["old"]);
  });

  it("should_treat_set_then_delete_as_removal", async () => {
    const buf = new ConversationStateBuffer("c1", "inst");
    buf.api().set("k", "v");
    buf.api().delete("k");
    await buf.flush();
    expect(flushMock).toHaveBeenCalledWith("c1", "inst", {}, ["k"]);
  });

  it("should_return_defensive_copy_from_getAll", () => {
    const buf = new ConversationStateBuffer("c1", "inst", { a: { n: 1 } });
    const all = buf.api().getAll();
    (all.a as { n: number }).n = 999;
    expect((buf.api().get("a") as { n: number }).n).toBe(1);
  });

  it("should_throw_on_non_serializable_value", () => {
    const buf = new ConversationStateBuffer("c1", "inst");
    expect(() => buf.api().set("fn", () => 1)).toThrow(/serializable/);
    expect(() => buf.api().set("big", BigInt(1))).toThrow();
  });

  it("should_throw_when_exceeding_size_cap", () => {
    const buf = new ConversationStateBuffer("c1", "inst");
    const huge = "x".repeat(MAX_STATE_BYTES + 1);
    expect(() => buf.api().set("big", huge)).toThrow(/exceed/);
  });

  it("should_expose_seeded_channel_via_channel_getter", () => {
    const buf = new ConversationStateBuffer("c1", "inst");
    buf.seedChannel({ type: "whatsapp", id: "+39", userName: "Mario" });
    expect(buf.api().channel).toEqual({ type: "whatsapp", id: "+39", userName: "Mario" });
    expect(buf.api().get(CHANNEL_STATE_KEY)).toEqual({
      type: "whatsapp",
      id: "+39",
      userName: "Mario",
    });
  });

  it("should_return_undefined_channel_when_not_seeded", () => {
    const buf = new ConversationStateBuffer("c1", "inst");
    expect(buf.api().channel).toBeUndefined();
  });

  it("should_not_mark_channel_dirty_when_unchanged", async () => {
    const buf = new ConversationStateBuffer("c1", "inst", {
      [CHANNEL_STATE_KEY]: { type: "whatsapp", id: "+39" },
    });
    buf.seedChannel({ type: "whatsapp", id: "+39" });
    await buf.flush();
    expect(flushMock).not.toHaveBeenCalled();
  });

  it("should_mark_channel_dirty_when_changed", async () => {
    const buf = new ConversationStateBuffer("c1", "inst", {
      [CHANNEL_STATE_KEY]: { type: "whatsapp", id: "+39" },
    });
    buf.seedChannel({ type: "whatsapp", id: "+41" });
    await buf.flush();
    expect(flushMock).toHaveBeenCalledWith(
      "c1",
      "inst",
      { [CHANNEL_STATE_KEY]: { type: "whatsapp", id: "+41" } },
      [],
    );
  });

  it("should_load_initial_state_via_static_load", async () => {
    loadMock.mockResolvedValue({ contactId: "z" });
    const buf = await ConversationStateBuffer.load("c1", "inst");
    expect(loadMock).toHaveBeenCalledWith("c1");
    expect(buf.api().get("contactId")).toBe("z");
  });

  it("should_clear_dirty_after_flush", async () => {
    const buf = new ConversationStateBuffer("c1", "inst");
    buf.api().set("k", "v");
    await buf.flush();
    flushMock.mockClear();
    await buf.flush();
    expect(flushMock).not.toHaveBeenCalled();
  });
});
