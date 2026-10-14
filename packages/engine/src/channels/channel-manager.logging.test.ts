// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockInitialize } = vi.hoisted(() => ({ mockInitialize: vi.fn().mockResolvedValue(undefined) }));

vi.mock("../instances/store.js", () => ({ findInstanceBySlug: vi.fn() }));
vi.mock("../platform/platform-settings.store.js", () => ({
  resolvePlatformSettings: vi.fn().mockResolvedValue({ baseUrl: "http://localhost" }),
}));
vi.mock("../instances/channels.store.js", () => ({
  ensureTelegramWebhookSecret: vi.fn().mockResolvedValue("s"),
  getChannelConfigs: vi.fn().mockResolvedValue([]),
  disableChannel: vi.fn(),
}));
vi.mock("./adapters/telegram/index.js", () => ({
  TelegramAdapter: vi.fn().mockImplementation(function (this: any) {
    this.name = "telegram";
    this.initialize = mockInitialize;
    this.shutdown = vi.fn();
    this.deregister = vi.fn();
  }),
}));

vi.mock("./adapters/slack/index.js", () => ({ SlackAdapter: vi.fn() }));
vi.mock("./adapters/whatsapp/index.js", () => ({ WhatsAppAdapter: vi.fn() }));

async function incomingOutputAt(level: string): Promise<string> {
  vi.resetModules();
  process.env.LOG_LEVEL = level;
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  const { ChannelManager } = await import("./channel-manager.js");
  const manager = new ChannelManager();
  manager.setMessageHandler(vi.fn().mockResolvedValue({ text: "ok" }));
  await manager.startChannel("my-agent", "telegram", { botToken: "t" });
  const handler = mockInitialize.mock.calls.at(-1)![0];
  vi.useFakeTimers();
  try {
    await handler({ channelType: "telegram", instanceId: "my-agent", channelId: "c1", userName: "Mario Rossi", text: "hi" });
    // The coordinator holds a burst briefly before running the pipeline.
    await vi.advanceTimersByTimeAsync(30_000);
  } finally {
    vi.useRealTimers();
  }
  return spy.mock.calls.map((c: unknown[]) => c.map(String).join(" ")).join("\n");
}

describe("ChannelManager incoming-message log", () => {
  const original = process.env.LOG_LEVEL;
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    if (original === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = original;
  });

  it("omits the contact name at info", async () => {
    const out = await incomingOutputAt("info");
    expect(out).toContain("Incoming message");
    expect(out).not.toContain("Mario Rossi");
  });

  it("prints the contact name at debug", async () => {
    expect(await incomingOutputAt("debug")).toContain("Mario Rossi");
  });
});
