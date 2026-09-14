// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, afterEach, vi } from "vitest";
import { ArtifactStore, artifactApiFor } from "./artifact-store.js";

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
    expect(store.take(handle, null)).toBeNull();
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
    const mine = artifactApiFor("conv-1");
    const theirs = artifactApiFor("conv-2");
    const handle = mine.put(payload());
    expect(theirs.take(handle)).toBeNull();
    expect(mine.take(handle)?.filename).toBe("q.pdf");
  });
});
