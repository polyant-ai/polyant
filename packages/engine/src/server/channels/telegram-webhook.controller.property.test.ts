// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { NotFoundException } from "@nestjs/common";

/*
  Telegram authenticates its webhook with X-Telegram-Bot-Api-Secret-Token, a
  secret we chose when registering the hook. Property: the update is accepted
  exactly when the header equals the channel's secret; every other header, of
  any length (absent, empty, a prefix, an extension), gets the same 404 and the
  adapter never sees the update. Only the stores and the channel manager are
  stubbed.
*/

const { channel } = vi.hoisted(() => ({
  channel: { webhookSecret: "", handleInbound: (() => Promise.resolve()) as (u: unknown) => Promise<void> },
}));

vi.mock("../../channels/channel-manager.js", () => ({ channelManager: { getAdapter: () => channel } }));
vi.mock("../../instances/channels.store.js", () => ({ getChannelConfig: async () => ({ enabled: true }) }));
vi.mock("../../instances/resolve-instance-id.js", () => ({ resolveInstanceId: async () => "instance-id" }));

const { TelegramWebhookController } = await import("./telegram-webhook.controller.js");

describe("Telegram webhook secret (property)", () => {
  it("accepts exactly the channel's secret and answers 404, never a crash, to any other header", async () => {
    // Telegram allows 1-256 characters A-Z, a-z, 0-9, _ and -.
    const stored = fc.stringMatching(/^[A-Za-z0-9_-]{1,256}$/);
    const header = (secret: string) =>
      fc.oneof(
        fc.constant<string | undefined>(secret),
        fc.constant<string | undefined>(undefined),
        fc.string({ unit: "grapheme", maxLength: 300 }),
        fc.nat({ max: 256 }).map((n) => secret.slice(0, n)),
        fc.stringMatching(/^[A-Za-z0-9_-]{1,8}$/).map((x) => secret + x),
        fc.nat().map((i) => {
          const at = i % secret.length;
          const swapped = secret[at] === "a" ? "b" : "a";
          return secret.slice(0, at) + swapped + secret.slice(at + 1);
        }),
      );

    await fc.assert(
      fc.asyncProperty(
        stored.chain((s) => fc.tuple(fc.constant(s), header(s))),
        async ([secret, sent]) => {
          const handled: unknown[] = [];
          channel.webhookSecret = secret;
          channel.handleInbound = async (update) => void handled.push(update);
          const controller = new TelegramWebhookController();
          const outcome = controller.receive("agent", sent, { update_id: 1 });
          if (sent === secret) {
            await expect(outcome).resolves.toEqual({ status: "accepted" });
            expect(handled).toEqual([{ update_id: 1 }]);
          } else {
            await expect(outcome).rejects.toBeInstanceOf(NotFoundException);
            expect(handled).toEqual([]);
          }
        },
      ),
      { numRuns: 400 },
    );
  });
});
