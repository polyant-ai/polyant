// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import type { FeedEvent } from "@/lib/activity-stream/types";
import type { MonitorItem } from "@/lib/api-types";
import { foldFresh, liveItemFromEvent, liveMatches, registerLiveEvent, registerLiveMatch, withLive } from "./live";

const instance = { id: "i1", slug: "sales", name: "Sales", icon: null };

function ev(partial: Partial<FeedEvent>): FeedEvent {
  return { id: "e1", ts: "2026-03-01T10:00:05.000Z", persona: "agent", text: "x", instance, ...partial };
}

function stored(partial: Partial<MonitorItem>): MonitorItem {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    type: "tool_call",
    group: "agents",
    time: "2026-03-01T10:00:04.500000Z",
    agent: { slug: "sales", name: "Sales" },
    conversationId: "c1",
    summary: "crm: create_contact",
    outcome: "ok",
    durationMs: 5,
    ...partial,
  };
}

describe("liveItemFromEvent", () => {
  it("turns a finished tool call into a tool_call row carrying its previews", () => {
    const row = liveItemFromEvent(
      ev({ tool: { name: "crm", summary: "create_contact" }, status: "success", conversationId: "c1", argsPreview: "email: a", resultPreview: "ok", durationMs: 7 }),
    );
    expect(row).toMatchObject({ type: "tool_call", group: "agents", outcome: "ok", summary: "crm: create_contact", durationMs: 7 });
    expect(row?.detail.sections.map((s) => s.key)).toEqual(["arguments", "output"]);
  });

  it("ignores a tool call that has not ended, replies and reasoning", () => {
    expect(liveItemFromEvent(ev({ tool: { name: "crm", summary: "" } }))).toBeNull();
    expect(liveItemFromEvent(ev({ text: "hello" }))).toBeNull();
    expect(liveItemFromEvent(ev({ persona: "thinking" }))).toBeNull();
  });

  it("keys a cron fire by its run id so the stored run replaces it", () => {
    const row = liveItemFromEvent(ev({ category: "cron", cron: { name: "Nightly", schedule: "0 3 * * *", runId: "run-1" } }));
    expect(row).toMatchObject({ type: "scheduled_run", id: "run-1", outcome: "running", summary: "Nightly" });
  });

  it("ignores an event with no agent", () => {
    expect(liveItemFromEvent(ev({ instance: undefined, tool: { name: "a", summary: "" }, status: "success" }))).toBeNull();
  });
});

describe("registered live events", () => {
  const custom = (partial: Partial<FeedEvent> = {}) => ev({ id: "n:1", category: "custom" as FeedEvent["category"], text: "note", instance: undefined, ...partial });

  it("leaves out an event of a category nobody registered", () => {
    expect(liveItemFromEvent(custom())).toBeNull();
  });

  it("turns a registered category into a row with its facts, and an empty agent when it is about none", () => {
    registerLiveEvent("custom", (e) => ({ type: "note", group: "notes", outcome: "ok", summary: e.text, facts: { kind: "x" }, noAgent: true }));
    const row = liveItemFromEvent(custom());
    expect(row).toMatchObject({ type: "note", group: "notes", agent: { slug: "", name: "" }, summary: "note", facts: { kind: "x" }, conversationId: null });
    expect(row?.detail.sections).toEqual([]);
  });

  it("still needs an agent for a registered category that is about one", () => {
    registerLiveEvent("custom", (e) => ({ type: "note", group: "notes", outcome: "blocked", summary: e.text, id: "own-id" }));
    expect(liveItemFromEvent(custom())).toBeNull();
    expect(liveItemFromEvent(custom({ instance }))).toMatchObject({ type: "note", id: "own-id", outcome: "blocked", agent: { slug: "sales" } });
  });

  it("drops a live row once the stored row its type's matcher accepts is read, and not another", () => {
    registerLiveEvent("custom", (e) => ({ type: "note", group: "notes", outcome: "ok", summary: e.text, facts: { what: "a" }, noAgent: true }));
    registerLiveMatch("note", (a, b, windowMs) => a.facts?.what === b.facts?.what && Math.abs(Date.parse(a.time) - Date.parse(b.time)) <= windowMs);
    const live = liveItemFromEvent(custom())!;
    const row = stored({ type: "note", group: "notes", agent: { slug: "", name: "" }, conversationId: null, facts: { what: "a" } });
    expect(withLive([row], [live])).toHaveLength(1);
    expect(withLive([{ ...row, facts: { what: "b" } }], [live])).toHaveLength(2);
  });
});

describe("withLive", () => {
  it("drops a live tool call once the stored row for it is read", () => {
    const live = liveItemFromEvent(ev({ tool: { name: "crm", summary: "create_contact" }, status: "success", conversationId: "c1" }))!;
    expect(withLive([stored({})], [live])).toHaveLength(1);
  });

  it("keeps a live tool call that no stored row matches (a tool that does not audit)", () => {
    const live = liveItemFromEvent(ev({ tool: { name: "search", summary: "q" }, status: "success", conversationId: "c1" }))!;
    expect(withLive([stored({})], [live])).toHaveLength(2);
  });

  it("does not match a stored row of another conversation or of a much different time", () => {
    const live = liveItemFromEvent(ev({ tool: { name: "crm", summary: "x" }, status: "success", conversationId: "c1" }))!;
    expect(withLive([stored({ conversationId: "c2" })], [live])).toHaveLength(2);
    expect(withLive([stored({ time: "2026-03-01T09:59:00.000000Z" })], [live])).toHaveLength(2);
  });

  it("drops a live row for a run once the stored run with the same id is read", () => {
    const live = liveItemFromEvent(ev({ category: "cron", cron: { name: "Nightly", schedule: "s", runId: "00000000-0000-4000-8000-000000000009" } }))!;
    const run = stored({ id: "00000000-0000-4000-8000-000000000009", type: "scheduled_run", group: "automations", summary: "Nightly", conversationId: null });
    expect(withLive([run], [live])).toEqual([run]);
  });

  it("puts live rows first, newest first", () => {
    const live = liveItemFromEvent(ev({ tool: { name: "search", summary: "q" }, status: "success", ts: "2026-03-01T10:00:09.000Z" }))!;
    expect(withLive([stored({})], [live])[0]).toBe(live);
  });

  it("drops a live row older than the oldest stored row the user has paged to", () => {
    const live = liveItemFromEvent(ev({ tool: { name: "search", summary: "q" }, status: "success", ts: "2026-03-01T09:00:00.000Z" }))!;
    expect(withLive([stored({})], [live])).toHaveLength(1);
  });
});

describe("liveMatches", () => {
  const row = liveItemFromEvent(ev({ tool: { name: "crm", summary: "x" }, status: "error" }))!;
  it("applies group, type, agent and outcome like the engine does", () => {
    expect(liveMatches(row, {})).toBe(true);
    expect(liveMatches(row, { group: "automations" })).toBe(false);
    expect(liveMatches(row, { types: ["hook"] })).toBe(false);
    expect(liveMatches(row, { agent: "other" })).toBe(false);
    expect(liveMatches(row, { outcome: "ok" })).toBe(false);
    expect(liveMatches(row, { outcome: "error", agent: "sales", group: "agents" })).toBe(true);
  });
  it("never matches a free-text search, nor a type the caller cannot read", () => {
    expect(liveMatches(row, { q: "crm" })).toBe(false);
    expect(liveMatches(row, { readable: ["hook"] })).toBe(false);
  });
});

describe("foldFresh", () => {
  it("adds new rows and replaces a held row of the same key without repeating it", () => {
    const held = [stored({ id: "00000000-0000-4000-8000-000000000001", outcome: "running" })];
    const fresh = [stored({ id: "00000000-0000-4000-8000-000000000001", outcome: "ok" }), stored({ id: "00000000-0000-4000-8000-000000000002", time: "2026-03-01T10:00:09.000000Z" })];
    const folded = foldFresh(held, fresh);
    expect(folded.map((i) => i.id)).toEqual(["00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000001"]);
    expect(folded[1]?.outcome).toBe("ok");
  });
});
