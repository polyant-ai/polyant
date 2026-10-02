// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, afterEach, vi } from "vitest";
import { ArtifactStore, artifactApiFor, artifactBinding } from "./artifact-store.js";

const payload = () => ({ buffer: Buffer.from("%PDF-1.4"), filename: "q.pdf", mime: "application/pdf" });

describe("ArtifactStore", () => {
  afterEach(() => vi.useRealTimers());

  it("round-trips bytes within the same conversation", () => {
    const store = new ArtifactStore();
    const handle = store.put(payload(), "conv-1");
    expect(handle).toMatch(/^artifact_/);
    const taken = store.take(handle, "conv-1");
    expect(taken?.filename).toBe("q.pdf");
    expect(taken?.buffer.toString()).toBe("%PDF-1.4");
    store.stopCleanupTimer();
  });

  it("is one-shot: a second take returns null", () => {
    const store = new ArtifactStore();
    const handle = store.put(payload(), "conv-1");
    expect(store.take(handle, "conv-1")).not.toBeNull();
    expect(store.take(handle, "conv-1")).toBeNull();
    store.stopCleanupTimer();
  });

  it("refuses a handle minted in another conversation, and leaves it takeable by its owner", () => {
    const store = new ArtifactStore();
    const handle = store.put(payload(), "conv-1");
    expect(store.take(handle, "conv-2")).toBeNull();
    expect(store.take(handle, "conv-none")).toBeNull();
    // The rejected takes must not have consumed it.
    expect(store.take(handle, "conv-1")).not.toBeNull();
    store.stopCleanupTimer();
  });

  it("expires after the TTL", () => {
    vi.useFakeTimers();
    const store = new ArtifactStore();
    const handle = store.put(payload(), "conv-1", 1_000);
    vi.advanceTimersByTime(1_001);
    expect(store.take(handle, "conv-1")).toBeNull();
    store.stopCleanupTimer();
  });

  it("rejects oversized artifacts and TTLs instead of retaining unbounded data", () => {
    const store = new ArtifactStore();
    expect(() => store.put({ ...payload(), buffer: Buffer.alloc(10 * 1024 * 1024 + 1) }, "conv-1"))
      .toThrow(RangeError);
    expect(() => store.put(payload(), "conv-1", 10 * 60 * 1000 + 1)).toThrow(RangeError);
    expect(store.size()).toBe(0);
  });

  it("caps aggregate retained bytes across conversations", () => {
    const store = new ArtifactStore();
    const tenMb = { ...payload(), buffer: Buffer.alloc(10 * 1024 * 1024) };
    for (let i = 0; i < 10; i++) store.put(tenMb, `conv-${i}`);

    expect(() => store.put(payload(), "extra")).toThrow(RangeError);
    store.stopCleanupTimer();
  });

  it("cleanup() drops only expired entries", () => {
    vi.useFakeTimers();
    const store = new ArtifactStore();
    store.put(payload(), "conv-1", 1_000);
    const live = store.put(payload(), "conv-1", 60_000);
    vi.advanceTimersByTime(1_001);
    expect(store.cleanup()).toBe(1);
    expect(store.size()).toBe(1);
    expect(store.take(live, "conv-1")).not.toBeNull();
    store.stopCleanupTimer();
  });

  it("artifactApiFor binds the conversation the tool runs in", () => {
    const mine = artifactApiFor("agent-a", "conv-1");
    const theirs = artifactApiFor("agent-a", "conv-2");
    const handle = mine.put(payload());
    expect(theirs.take(handle)).toBeNull();
    expect(mine.take(handle)?.filename).toBe("q.pdf");
  });

  it("keeps the conversation-less turns of two agents apart", () => {
    // Every turn without a conversation used to bind to null, one bucket shared
    // by every agent of every tenant in the process.
    const handle = artifactApiFor("agent-a", null).put(payload());
    expect(artifactApiFor("agent-b", null).take(handle)).toBeNull();
    expect(artifactApiFor("agent-a", undefined).take(handle)?.filename).toBe("q.pdf");
  });

  it("caps what one conversation holds, so it cannot fill the store for the others", () => {
    const store = new ArtifactStore();
    const one = artifactBinding("agent-a", "conv-1");
    for (let i = 0; i < 20; i++) store.put(payload(), one);

    expect(() => store.put(payload(), one)).toThrow(/20 artifacts or 25 MB/);
    // Another conversation is unaffected, and taking one frees a slot.
    expect(() => store.put(payload(), artifactBinding("agent-a", "conv-2"))).not.toThrow();
    store.stopCleanupTimer();
  });

  it("caps the bytes one conversation holds", () => {
    const store = new ArtifactStore();
    const one = artifactBinding("agent-a", "conv-1");
    const tenMb = { ...payload(), buffer: Buffer.alloc(10 * 1024 * 1024) };
    const first = store.put(tenMb, one);
    store.put(tenMb, one);

    expect(() => store.put(tenMb, one)).toThrow(/20 artifacts or 25 MB/);
    store.take(first, one);
    expect(() => store.put(tenMb, one)).not.toThrow();
    store.stopCleanupTimer();
  });
});
