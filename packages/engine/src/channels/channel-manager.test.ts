// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChannelManager } from "./channel-manager.js";
import type { MessageHandler } from "./types.js";
import { asInstanceSlug } from "../instances/identifiers.js";

const { mockFindInstanceBySlug, mockTelegramInitialize } = vi.hoisted(() => ({
  mockFindInstanceBySlug: vi.fn(),
  mockTelegramInitialize: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../instances/store.js", () => ({ findInstanceBySlug: mockFindInstanceBySlug }));
vi.mock("../platform/platform-settings.store.js", () => ({
  resolvePlatformSettings: vi.fn().mockResolvedValue({ baseUrl: "https://engine.example.test" }),
}));

// Mock DB-dependent imports
vi.mock("../instances/channels.store.js", () => ({
  listEnabledChannelConfigs: vi.fn().mockResolvedValue([]),
  // Keep in sync with the real tuple in instances/channels.store.ts —
  // any new API-configurable channel type must be added here.
  CHANNEL_TYPES: ["telegram", "slack", "whatsapp", "agent"],
}));

vi.mock("./adapters/telegram/index.js", () => ({
  TelegramAdapter: vi.fn().mockImplementation(function (this: any, _instanceId: string) {
    this.name = "telegram";
    this.initialize = mockTelegramInitialize;
    this.sendMessage = vi.fn().mockResolvedValue(undefined);
    this.shutdown = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock("./adapters/slack/index.js", () => ({
  SlackAdapter: vi.fn().mockImplementation(function (this: any, _instanceId: string) {
    this.name = "slack";
    this.initialize = vi.fn().mockResolvedValue(undefined);
    this.sendMessage = vi.fn().mockResolvedValue(undefined);
    this.shutdown = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock("./adapters/whatsapp/index.js", () => ({
  WhatsAppAdapter: vi.fn().mockImplementation(function (this: any, _instanceId: string) {
    this.name = "whatsapp";
    this.initialize = vi.fn().mockResolvedValue(undefined);
    this.sendMessage = vi.fn().mockResolvedValue(undefined);
    this.shutdown = vi.fn().mockResolvedValue(undefined);
  }),
}));

describe("ChannelManager", () => {
  let manager: ChannelManager;

  beforeEach(() => {
    mockFindInstanceBySlug.mockReset();
    mockTelegramInitialize.mockClear();
    manager = new ChannelManager();
    manager.setMessageHandler(vi.fn().mockResolvedValue({ text: "ok" }));
  });

  describe("getActiveChannels", () => {
    it("returns empty array when no channels started", () => {
      expect(manager.getActiveChannels()).toEqual([]);
    });
  });

  describe("startChannel / stopChannel", () => {
    it("starts a telegram channel for an instance", async () => {
      await manager.startChannel("my-instance", "telegram", { botToken: "test-token" });
      const active = manager.getActiveChannels();
      expect(active).toEqual([{ instanceSlug: "my-instance", channelType: "telegram" }]);
    });

    it("starts multiple channels for the same instance", async () => {
      await manager.startChannel("my-instance", "telegram", { botToken: "test" });
      await manager.startChannel("my-instance", "slack", { botToken: "t", appToken: "a", signingSecret: "s" });
      expect(manager.getActiveChannels()).toHaveLength(2);
    });

    it("stops a channel", async () => {
      await manager.startChannel("my-instance", "telegram", { botToken: "test" });
      await manager.stopChannel("my-instance", "telegram");
      expect(manager.getActiveChannels()).toEqual([]);
    });

    it("stopChannel is safe to call for non-existent channels", async () => {
      await expect(manager.stopChannel("nonexistent", "telegram")).resolves.not.toThrow();
    });

    it("starts a whatsapp channel for an instance", async () => {
      await manager.startChannel("my-instance", "whatsapp", {
        accountSid: "AC123",
        authToken: "token",
        whatsappNumber: "+14155238886",
      });
      const active = manager.getActiveChannels();
      expect(active).toEqual([{ instanceSlug: "my-instance", channelType: "whatsapp" }]);
    });

    it("restarts a channel when called again for same instance+type", async () => {
      await manager.startChannel("my-instance", "telegram", { botToken: "token1" });
      await manager.startChannel("my-instance", "telegram", { botToken: "token2" });
      expect(manager.getActiveChannels()).toHaveLength(1);
    });
  });

  describe("stopAllForInstance", () => {
    it("stops all channels for an instance", async () => {
      await manager.startChannel("inst1", "telegram", { botToken: "t" });
      await manager.startChannel("inst1", "slack", { botToken: "t", appToken: "a", signingSecret: "s" });
      await manager.startChannel("inst2", "telegram", { botToken: "t" });

      await manager.stopAllForInstance("inst1");

      const active = manager.getActiveChannels();
      expect(active).toEqual([{ instanceSlug: "inst2", channelType: "telegram" }]);
    });
  });

  describe("shutdownAll", () => {
    it("shuts down all channels across all instances", async () => {
      await manager.startChannel("inst1", "telegram", { botToken: "t" });
      await manager.startChannel("inst2", "slack", { botToken: "t", appToken: "a", signingSecret: "s" });

      await manager.shutdownAll();

      expect(manager.getActiveChannels()).toEqual([]);
    });
  });

  describe("setMessageHandler", () => {
    it("throws when starting a channel without message handler", async () => {
      const freshManager = new ChannelManager();
      await expect(
        freshManager.startChannel("inst", "telegram", { botToken: "t" }),
      ).rejects.toThrow("Message handler not set");
    });
  });

  it("accepts an inbound fragment with default timings when the agent lookup fails", async () => {
    vi.useFakeTimers();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mockFindInstanceBySlug.mockRejectedValue(new Error("database unavailable"));
      await manager.startChannel("my-instance", "telegram", { botToken: "test-token" });
      const onMessage = mockTelegramInitialize.mock.calls[0][0] as MessageHandler;

      await expect(onMessage({
        channelType: "telegram",
        channelId: "chat-1",
        instanceId: asInstanceSlug("my-instance"),
        text: "hello",
        metadata: {},
      })).resolves.toEqual({ text: "" });
      expect(errorLog).toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      errorLog.mockRestore();
    }
  });
});
