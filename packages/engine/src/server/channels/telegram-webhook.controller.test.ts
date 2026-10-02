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

  it("acknowledges before the turn finishes, so Telegram does not deliver the update again", async () => {
    // Telegram resends an update its webhook has not answered; the handler used
    // to await the whole turn (download, transcription, the agent) first.
    const controller = new TelegramWebhookController();
    handleInbound.mockReset().mockReturnValue(new Promise(() => {}));
    const secret = createHash("sha256").update("bot-token").digest("hex");

    await expect(controller.receive("agent", secret, { update_id: 8 })).resolves.toEqual({ status: "accepted" });
    expect(handleInbound).toHaveBeenCalledWith({ update_id: 8 });
  });

  it("answers 200 even when processing the update fails", async () => {
    const controller = new TelegramWebhookController();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    handleInbound.mockReset().mockRejectedValue(new Error("boom"));
    const secret = createHash("sha256").update("bot-token").digest("hex");

    await expect(controller.receive("agent", secret, { update_id: 9 })).resolves.toEqual({ status: "accepted" });
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    error.mockRestore();
  });
});
