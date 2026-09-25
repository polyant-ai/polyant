// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";

const handleInbound = vi.fn().mockResolvedValue(undefined);
vi.mock("../../channels/channel-manager.js", () => ({
  channelManager: {
    getAdapter: () => ({ webhookSecret: createHash("sha256").update("bot-token").digest("hex"), handleInbound }),
  },
}));
vi.mock("../../instances/channels.store.js", () => ({
  getChannelConfig: vi.fn().mockResolvedValue({ enabled: true }),
}));
vi.mock("../../instances/resolve-instance-id.js", () => ({
  resolveInstanceId: vi.fn().mockResolvedValue("instance-id"),
}));

const { TelegramWebhookController } = await import("./telegram-webhook.controller.js");

describe("Telegram webhook", () => {
  it("rejects a wrong secret and forwards a valid update", async () => {
    const controller = new TelegramWebhookController();
    handleInbound.mockClear();
    await expect(controller.receive("agent", "wrong", { update_id: 7 })).rejects.toBeInstanceOf(NotFoundException);
    expect(handleInbound).not.toHaveBeenCalled();

    const secret = createHash("sha256").update("bot-token").digest("hex");
    await expect(controller.receive("agent", secret, { update_id: 7 })).resolves.toEqual({ status: "accepted" });
    expect(handleInbound).toHaveBeenCalledWith({ update_id: 7 });
  });
});
