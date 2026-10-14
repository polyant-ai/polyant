// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";

const handleInbound = vi.fn().mockResolvedValue(undefined);
vi.mock("../../channels/channel-manager.js", () => ({
  channelManager: {
    getAdapter: () => ({ webhookSecret: "per-channel-random-secret", handleInbound }),
  },
}));
vi.mock("../../instances/channels.store.js", () => ({
  getChannelConfig: vi.fn().mockResolvedValue({ enabled: true }),
}));
vi.mock("../../instances/resolve-instance-id.js", () => ({
  resolveInstanceId: vi.fn().mockResolvedValue("instance-id"),
}));

const { TelegramWebhookController } = await import("./telegram-webhook.controller.js");
const { pendingBackgroundTurns } = await import("../../channels/background-turns.js");

describe("Telegram webhook", () => {
  it("rejects a wrong secret and forwards a valid update", async () => {
    const controller = new TelegramWebhookController();
    handleInbound.mockClear();
    await expect(controller.receive("agent", "wrong", { update_id: 7 })).rejects.toBeInstanceOf(NotFoundException);
    expect(handleInbound).not.toHaveBeenCalled();

    const secret = "per-channel-random-secret";
    await expect(controller.receive("agent", secret, { update_id: 7 })).resolves.toEqual({ status: "accepted" });
    expect(handleInbound).toHaveBeenCalledWith({ update_id: 7 });
  });

  it("acknowledges before the turn finishes, so Telegram does not deliver the update again", async () => {
    // Telegram resends an update its webhook has not answered; the handler used
    // to await the whole turn (download, transcription, the agent) first.
    const controller = new TelegramWebhookController();
    handleInbound.mockReset().mockReturnValue(new Promise(() => {}));
    const secret = "per-channel-random-secret";

    await expect(controller.receive("agent", secret, { update_id: 8 })).resolves.toEqual({ status: "accepted" });
    expect(handleInbound).toHaveBeenCalledWith({ update_id: 8 });
  });

  it("leaves the acknowledged turn for shutdown to wait on", async () => {
    // Once answered 200, Telegram never delivers the update again: a turn the
    // shutdown sequence cut off after the HTTP server closed was lost.
    const controller = new TelegramWebhookController();
    let finish!: () => void;
    handleInbound.mockReset().mockReturnValue(new Promise<void>((r) => (finish = r)));
    const secret = "per-channel-random-secret";
    const before = pendingBackgroundTurns();

    await controller.receive("agent", secret, { update_id: 10 });
    expect(pendingBackgroundTurns()).toBe(before + 1);

    finish();
    await vi.waitFor(() => expect(pendingBackgroundTurns()).toBe(before));
  });

  it("answers 200 even when processing the update fails", async () => {
    const controller = new TelegramWebhookController();
    const error = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    handleInbound.mockReset().mockRejectedValue(new Error("boom"));
    const secret = "per-channel-random-secret";

    await expect(controller.receive("agent", secret, { update_id: 9 })).resolves.toEqual({ status: "accepted" });
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(expect.stringContaining("webhook processing failed for agent — boom")),
    );
    error.mockRestore();
  });
});
