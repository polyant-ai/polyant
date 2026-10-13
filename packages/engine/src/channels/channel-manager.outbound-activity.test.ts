// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A proactive outbound send shows up in the activity stream, except on the
 * agent channel, whose sends the agent-handoff events already report. Observed
 * on the real activity bus: a channel left out of the feed is lost signal in
 * the panel, and a channel reported twice double-counts.
 */

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockTelegramSend } = vi.hoisted(() => ({ mockTelegramSend: vi.fn() }));

vi.mock("../instances/store.js", () => ({ findInstanceBySlug: vi.fn() }));
vi.mock("../instances/instance-meta.js", () => ({
  resolveInstanceMeta: vi.fn(async (slug: string) => ({ slug, name: slug })),
}));
vi.mock("../platform/platform-settings.store.js", () => ({
  resolvePlatformSettings: vi.fn().mockResolvedValue({ baseUrl: "https://engine.test" }),
}));
vi.mock("../instances/channels.store.js", () => ({
  ensureTelegramWebhookSecret: vi.fn().mockResolvedValue("secret"),
  listEnabledChannelConfigs: vi.fn().mockResolvedValue([]),
  disableChannel: vi.fn(),
}));
vi.mock("../optout/index.js", () => ({ getOptoutStatus: vi.fn().mockResolvedValue("active") }));
vi.mock("./adapters/telegram/index.js", () => ({
  TelegramAdapter: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.name = "telegram";
    this.initialize = vi.fn().mockResolvedValue(undefined);
    this.shutdown = vi.fn();
    this.deregister = vi.fn();
    this.sendMessage = mockTelegramSend;
  }),
}));
vi.mock("./adapters/slack/index.js", () => ({ SlackAdapter: vi.fn() }));
vi.mock("./adapters/whatsapp/index.js", () => ({ WhatsAppAdapter: vi.fn() }));

import { activityBus } from "../activity-stream/activity-bus.js";
import type { FeedEvent } from "../activity-stream/activity-stream.types.js";
import { ChannelManager } from "./channel-manager.js";

describe("ChannelManager outbound activity", () => {
  let events: FeedEvent[];
  let unsubscribe: () => void;
  let manager: ChannelManager;
  /** Each test sends to its own chat ids: the bus replays earlier events to a new subscriber. */
  let chat: string;
  let caller: string;

  beforeEach(async () => {
    mockTelegramSend.mockReset().mockResolvedValue(undefined);
    events = [];
    chat = `chat-${randomUUID()}`;
    caller = `caller-${randomUUID()}`;
    unsubscribe = activityBus.subscribe((evt) => events.push(evt));
    manager = new ChannelManager();
    manager.setMessageHandler(vi.fn().mockResolvedValue({ text: "ok" }));
    await manager.startChannel("shop", "telegram", { botToken: "t" });
    await manager.startChannel("shop", "agent", {});
  });

  afterEach(() => unsubscribe());

  const outbound = () =>
    events.filter((e) => e.category === "outbound" && (e.channel?.id === chat || e.channel?.id === caller));

  it("reports a delivered telegram send", async () => {
    await manager.sendOutbound("shop", "telegram", chat, "Your order shipped");

    await vi.waitFor(() => expect(outbound()).toHaveLength(1));
    expect(outbound()[0]).toMatchObject({
      status: "success",
      channel: { type: "telegram", id: chat },
      instance: { slug: "shop" },
    });
  });

  it("reports a failed telegram send as an error", async () => {
    mockTelegramSend.mockRejectedValue(new Error("blocked by user"));

    await expect(manager.sendOutbound("shop", "telegram", chat, "hello")).rejects.toThrow("blocked by user");

    await vi.waitFor(() => expect(outbound()).toHaveLength(1));
    expect(outbound()[0]).toMatchObject({ status: "error", responsePreview: "blocked by user" });
  });

  it("does not report a send on the agent channel", async () => {
    await manager.sendOutbound("shop", "agent", caller, "handoff reply");
    await manager.sendOutbound("shop", "telegram", chat, "after");

    // The telegram send is the marker that emission has run; the agent one must
    // not have produced a second event before it.
    await vi.waitFor(() => expect(outbound()).toHaveLength(1));
    expect(outbound()[0].channel).toEqual({ type: "telegram", id: chat });
  });
});
