// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";

const { live, mockGetChannelConfig, mockResolveInstanceId } = vi.hoisted(() => ({
  live: new Map<string, object>(),
  mockGetChannelConfig: vi.fn(),
  mockResolveInstanceId: vi.fn(),
}));

vi.mock("../../channels/channel-manager.js", () => ({
  channelManager: { getAdapter: (slug: string, type: string) => live.get(`${slug}/${type}`) },
}));
vi.mock("../../instances/channels.store.js", () => ({
  getChannelConfig: mockGetChannelConfig,
  WHATSAPP_CHANNEL_TYPE: "whatsapp",
  WHATSAPP_AUTH_MODE_TOKEN: "authToken",
  WHATSAPP_AUTH_MODE_API_KEY: "apiKey",
  resolveWhatsAppAuthMode: () => "authToken",
}));
vi.mock("../../instances/resolve-instance-id.js", () => ({ resolveInstanceId: mockResolveInstanceId }));

import { channelWebhookTracker, requireLiveAdapter } from "./live-adapter.js";
import { resetThrottleTrackerState } from "../throttle-tracker.js";
import { TelegramWebhookController } from "./telegram-webhook.controller.js";
import { SlackWebhookController } from "./slack-webhook.controller.js";
import { TwilioWebhookController } from "./twilio-webhook.controller.js";

/** One address for every request: a load balancer's node with TRUST_PROXY unset. */
const LB = "10.0.0.7";
const track = channelWebhookTracker("telegram");
const request = (instanceSlug: string, ip = LB) => ({ ip, params: { instanceSlug } });

beforeEach(() => {
  live.clear();
  resetThrottleTrackerState();
  mockResolveInstanceId.mockReset().mockResolvedValue("uuid-1");
  mockGetChannelConfig.mockReset().mockResolvedValue({ enabled: true, config: { botToken: "t" } });
});

describe("channel webhook throttle bucket", () => {
  it("gives two bots behind the same balancer address separate buckets", () => {
    // Before: both were `ip:10.0.0.7`, so one busy bot spent every bot's budget.
    live.set("shop/telegram", {});
    live.set("clinic/telegram", {});

    expect(track(request("shop"))).not.toBe(track(request("clinic")));
    expect(track(request("shop"))).toBe(track(request("shop")));
  });

  it("keeps the sender's address in the bucket, so a stranger spends its own budget", () => {
    live.set("shop/telegram", {});
    expect(track(request("shop", "203.0.113.9"))).not.toBe(track(request("shop")));
  });

  it("falls back to the address for a slug with no running adapter, so rotating slugs mints nothing", () => {
    const buckets = new Set(["a", "b", "c"].map((slug) => track(request(slug))));
    expect([...buckets]).toEqual([`ip:${LB}`]);
  });

  it("never puts the slug in the key in clear", () => {
    live.set("shop/telegram", {});
    expect(track(request("shop"))).not.toContain("shop");
  });
});

describe("requireLiveAdapter", () => {
  const unavailable = () => ({ message: "Telegram webhook unavailable", log: vi.fn() });

  it("returns the running adapter and the stored config", async () => {
    const adapter = { name: "telegram" };
    live.set("shop/telegram", adapter);

    await expect(requireLiveAdapter("shop", "telegram", unavailable())).resolves.toEqual({
      adapter,
      config: { botToken: "t" },
    });
  });

  it.each([
    ["instance not found", () => mockResolveInstanceId.mockResolvedValue(undefined)],
    ["channel not configured or disabled", () => mockGetChannelConfig.mockResolvedValue({ enabled: false, config: {} })],
    ["adapter not active", () => undefined],
  ])("answers the same 404 when %s, and logs the real reason", async (reason, arrange) => {
    if (reason !== "adapter not active") live.set("shop/telegram", {});
    arrange();
    const opts = unavailable();

    const err = await requireLiveAdapter("shop", "telegram", opts).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).message).toBe("Telegram webhook unavailable");
    expect(opts.log).toHaveBeenCalledWith(reason);
  });
});

describe("public channel webhook routes", () => {
  type Tracker = (req: Record<string, unknown>) => string;
  const trackerOf = (proto: object, method: string): Tracker | undefined =>
    Reflect.getMetadata("THROTTLER:TRACKERdefault", (proto as Record<string, object>)[method]) as Tracker | undefined;

  it.each([
    ["telegram", TelegramWebhookController.prototype, "receive"],
    ["slack", SlackWebhookController.prototype, "receive"],
    ["whatsapp", TwilioWebhookController.prototype, "handleWhatsAppWebhook"],
    ["whatsapp", TwilioWebhookController.prototype, "handleWhatsAppWebhookWithSecret"],
  ])("throttle each %s bot on its own bucket (%#)", (type, proto, method) => {
    live.set(`shop/${type}`, {});
    live.set(`clinic/${type}`, {});
    const tracker = trackerOf(proto, method);

    expect(tracker).toBeTypeOf("function");
    expect(tracker!(request("shop"))).not.toBe(tracker!(request("clinic")));
  });
});
