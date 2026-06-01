// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const emitMock = vi.hoisted(() => vi.fn());
vi.mock("../activity-bus.js", () => ({
  activityBus: {
    emitEvent: emitMock,
    subscribe: vi.fn(),
    listenerCount: vi.fn(() => 0),
  },
}));

// Avoid pulling in the DB-backed instance store (which loads config.ts and
// calls process.exit(1) when AUTH_SECRET is missing in the test env).
vi.mock("../../instances/store.js", () => ({
  findInstanceBySlug: vi.fn().mockResolvedValue(null),
}));

import { emitInbound } from "./emit-inbound.js";
import { emitOutbound } from "./emit-outbound.js";
import { emitWebhook } from "./emit-webhook.js";
import { emitCron } from "./emit-cron.js";
import { emitMemory } from "./emit-memory.js";
import { emitConversation } from "./emit-conversation.js";
import { emitAgentHandoffStart, emitAgentHandoffEnd } from "./emit-agent-handoff.js";
import type { InstanceMeta } from "../activity-stream.types.js";

const inst: InstanceMeta = { id: "i-1", slug: "alpha", name: "Alpha", icon: null };

beforeEach(() => emitMock.mockReset());

function captured() {
  expect(emitMock).toHaveBeenCalledTimes(1);
  return emitMock.mock.calls[0][0];
}

describe("emitInbound", () => {
  it("emits a category=inbound event with channel meta", () => {
    emitInbound({
      channelType: "telegram",
      channelId: "chat-42",
      sender: "Mario",
      text: "ciao agente",
      conversationId: "conv-1",
      instance: inst,
    });
    const e = captured();
    expect(e.category).toBe("inbound");
    expect(e.text).toBe("telegram: ciao agente");
    expect(e.responsePreview).toBe("ciao agente");
    expect(e.channel).toEqual({ type: "telegram", id: "chat-42", sender: "Mario" });
    expect(e.status).toBe("success");
    expect(e.conversationId).toBe("conv-1");
  });

  it("truncates long inbound text", () => {
    const long = "x".repeat(1000);
    emitInbound({ channelType: "web", channelId: "c", text: long, conversationId: "c", instance: inst });
    const e = captured();
    expect(e.responsePreview!.length).toBeLessThanOrEqual(600);
    expect(e.text.length).toBeLessThanOrEqual(120); // channel + ": " + 80 chars + "…"
  });

  it("handles empty text gracefully", () => {
    emitInbound({ channelType: "web", channelId: "c", text: "  ", conversationId: "c" });
    const e = captured();
    expect(e.text).toContain("(nessun testo)");
    expect(e.responsePreview).toBeUndefined();
  });
});

describe("emitOutbound", () => {
  it("emits a category=outbound event with success status", () => {
    emitOutbound({ channelType: "slack", channelId: "#ops", text: "fatto", ok: true, instance: inst });
    const e = captured();
    expect(e.category).toBe("outbound");
    expect(e.status).toBe("success");
    expect(e.channel?.type).toBe("slack");
  });

  it("emits an error event when send fails", () => {
    emitOutbound({
      channelType: "telegram",
      channelId: "chat",
      text: "...",
      ok: false,
      error: "rate limited",
      instance: inst,
    });
    const e = captured();
    expect(e.status).toBe("error");
    expect(e.responsePreview).toBe("rate limited");
  });
});

describe("emitWebhook", () => {
  it("emits a digest of the payload, not the values", () => {
    emitWebhook({
      sourceName: "github",
      definitionName: "PR opened",
      action: "conversation",
      payload: { repo: "polyant-ai/polyant", pr: 42, secret_token: "abc123" },
      instance: inst,
    });
    const e = captured();
    expect(e.category).toBe("webhook");
    expect(e.text).toBe("github → PR opened");
    expect(e.responsePreview).toContain("repo");
    expect(e.responsePreview).not.toContain("abc123"); // never reflect values
    expect(e.webhook).toEqual({ source: "github", definition: "PR opened", action: "conversation" });
  });

  it("handles array payloads", () => {
    emitWebhook({
      sourceName: "stripe",
      definitionName: "events",
      action: "backlog",
      payload: [1, 2, 3],
      instance: inst,
    });
    const e = captured();
    expect(e.responsePreview).toContain("3 items");
  });
});

describe("emitCron", () => {
  it("emits a cron fire event with schedule + run id", () => {
    emitCron({
      taskName: "daily-brief",
      schedule: "0 8 * * *",
      prompt: "Build the daily brief",
      runId: "run-7",
      triggerType: "scheduled",
      instance: inst,
    });
    const e = captured();
    expect(e.category).toBe("cron");
    expect(e.text).toBe("cron: daily-brief");
    expect(e.cron?.schedule).toBe("0 8 * * *");
    expect(e.cron?.runId).toBe("run-7");
    expect(e.responsePreview).toBe("Build the daily brief");
  });
});

describe("emitMemory", () => {
  it("emits a single aggregated event per batch", () => {
    emitMemory({
      count: 3,
      categories: ["fact", "event", "fact"],
      firstMemoryText: "User likes coffee.",
      conversationId: "c",
      instance: inst,
    });
    const e = captured();
    expect(e.category).toBe("memory");
    expect(e.text).toBe("+3 memorie · event, fact"); // dedup + sort
    expect(e.memory?.count).toBe(3);
    expect(e.memory?.categories).toEqual(["event", "fact"]);
  });

  it("stays silent when count is zero", () => {
    emitMemory({ count: 0, categories: [], conversationId: "c", instance: inst });
    expect(emitMock).not.toHaveBeenCalled();
  });
});

describe("emitConversation", () => {
  it("emits a created lifecycle event", () => {
    emitConversation({
      conversationId: "c-99",
      lifecycle: "created",
      source: "user",
      channel: "telegram",
      instance: inst,
    });
    const e = captured();
    expect(e.category).toBe("conversation");
    expect(e.text).toBe("nuova conversazione · user · telegram");
    expect(e.conversation?.lifecycle).toBe("created");
  });

  it("emits an archived lifecycle event", () => {
    emitConversation({ conversationId: "c-99", lifecycle: "archived", instance: inst });
    const e = captured();
    expect(e.text).toBe("conversazione archiviata");
  });
});

describe("emitAgentHandoff", () => {
  const caller: InstanceMeta = { id: "i-from", slug: "concierge", name: "Concierge", icon: "🤖" };
  const target: InstanceMeta = { id: "i-to", slug: "acme-agent", name: "AcmeAgent", icon: "🦷" };
  const base = {
    eventBaseId: "handoff:conv-1:abc",
    fromInstance: caller,
    toInstance: target,
    toolName: "ask_acme_agent",
    prompt: "Verifica disponibilità per Jane Doe",
    callerConversationId: "conv-1",
  };

  it("start: emits category=agent-handoff with handoff meta and instance=caller", () => {
    emitAgentHandoffStart(base);
    const e = captured();
    expect(e.id).toBe("handoff:conv-1:abc:start");
    expect(e.category).toBe("agent-handoff");
    expect(e.persona).toBe("agent");
    expect(e.instance).toEqual(caller);
    expect(e.conversationId).toBe("conv-1");
    expect(e.text).toBe("→ AcmeAgent: Verifica disponibilità per Jane Doe");
    expect(e.handoff?.fromInstance).toEqual(caller);
    expect(e.handoff?.toInstance).toEqual(target);
    expect(e.handoff?.toolName).toBe("ask_acme_agent");
    expect(e.handoff?.prompt).toBe("Verifica disponibilità per Jane Doe");
    expect(e.status).toBeUndefined();
    expect(e.durationMs).toBeUndefined();
  });

  it("end: emits success status with durationMs and resultPreview", () => {
    emitAgentHandoffEnd({
      ...base,
      status: "success",
      durationMs: 1234,
      resultPreview: "Disponibilità confermata.",
    });
    const e = captured();
    expect(e.id).toBe("handoff:conv-1:abc:end");
    expect(e.category).toBe("agent-handoff");
    expect(e.status).toBe("success");
    expect(e.durationMs).toBe(1234);
    expect(e.resultPreview).toBe("Disponibilità confermata.");
    expect(e.handoff?.toInstance.slug).toBe("acme-agent");
  });

  it("end: error status carries the error message in resultPreview", () => {
    emitAgentHandoffEnd({
      ...base,
      status: "error",
      durationMs: 100,
      resultPreview: "Errore: timeout dopo 100ms",
    });
    const e = captured();
    expect(e.status).toBe("error");
    expect(e.resultPreview).toBe("Errore: timeout dopo 100ms");
  });

  it("truncates the prompt in handoff.prompt at 600 chars", () => {
    const long = "x".repeat(1000);
    emitAgentHandoffStart({ ...base, prompt: long });
    const e = captured();
    expect(e.handoff?.prompt.length).toBeLessThanOrEqual(600);
  });

  it("handles an empty prompt with the (prompt vuoto) placeholder in text", () => {
    emitAgentHandoffStart({ ...base, prompt: "   " });
    const e = captured();
    expect(e.text).toBe("→ AcmeAgent: (prompt vuoto)");
  });

  it("propagates childConversationId when provided", () => {
    emitAgentHandoffStart({ ...base, childConversationId: "agent:concierge:xyz" });
    const e = captured();
    expect(e.handoff?.childConversationId).toBe("agent:concierge:xyz");
  });
});
