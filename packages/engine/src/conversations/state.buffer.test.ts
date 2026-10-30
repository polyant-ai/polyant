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

  // Postgres hands jsonb keys back sorted by length, then bytes ({id, type, userName}), never in the order the
  // identity is built in ({type, id, userName}); state.store.integration.test.ts pins that order. Broken before:
  // every turn of an existing conversation rewrote `_channel` (an upsert and a commit before the reply).
  it("should_not_mark_channel_dirty_when_stored_in_jsonb_key_order", async () => {
    const buf = new ConversationStateBuffer("c1", "inst", {
      [CHANNEL_STATE_KEY]: { id: "+39", type: "whatsapp", userName: "Mario" },
    });
    buf.seedChannel({ type: "whatsapp", id: "+39", userName: "Mario" });
    await buf.flush();
    expect(flushMock).not.toHaveBeenCalled();
  });

  it("should_not_mark_channel_dirty_when_seeded_without_user_name", async () => {
    const buf = new ConversationStateBuffer("c1", "inst", {
      [CHANNEL_STATE_KEY]: { id: "+39", type: "whatsapp" },
    });
    buf.seedChannel({ type: "whatsapp", id: "+39", userName: undefined });
    await buf.flush();
    expect(flushMock).not.toHaveBeenCalled();
  });

  it("should_mark_channel_dirty_when_stored_identity_has_a_field_the_seed_lacks", async () => {
    const buf = new ConversationStateBuffer("c1", "inst", {
      [CHANNEL_STATE_KEY]: { id: "+39", type: "whatsapp", userName: "Mario" },
    });
    buf.seedChannel({ type: "whatsapp", id: "+39" });
    await buf.flush();
    expect(flushMock).toHaveBeenCalledWith("c1", "inst", { [CHANNEL_STATE_KEY]: { type: "whatsapp", id: "+39" } }, []);
  });

  it("should_mark_channel_dirty_when_stored_value_is_not_an_identity", async () => {
    const buf = new ConversationStateBuffer("c1", "inst", { [CHANNEL_STATE_KEY]: "+39" });
    buf.seedChannel({ type: "whatsapp", id: "+39" });
    await buf.flush();
    expect(flushMock).toHaveBeenCalledWith("c1", "inst", { [CHANNEL_STATE_KEY]: { type: "whatsapp", id: "+39" } }, []);
  });

  it("should_mark_channel_dirty_when_stored_value_is_null", async () => {
    const buf = new ConversationStateBuffer("c1", "inst", { [CHANNEL_STATE_KEY]: null });
    buf.seedChannel({ type: "whatsapp", id: "+39" });
    await buf.flush();
    expect(flushMock).toHaveBeenCalledWith("c1", "inst", { [CHANNEL_STATE_KEY]: { type: "whatsapp", id: "+39" } }, []);
  });

  it("should_not_mark_channel_dirty_again_when_the_same_identity_is_seeded_twice", async () => {
    const buf = new ConversationStateBuffer("c1", "inst");
    buf.seedChannel({ type: "telegram", id: "42", userName: undefined });
    await buf.flush();
    expect(flushMock).toHaveBeenCalledTimes(1);
    flushMock.mockClear();
    buf.seedChannel({ type: "telegram", id: "42", userName: undefined });
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
