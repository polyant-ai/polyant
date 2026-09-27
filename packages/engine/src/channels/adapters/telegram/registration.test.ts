// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Who owns the Telegram webhook registration. A bot has exactly one webhook URL,
 * held by Telegram. In a rolling deploy the new replica registers it before the
 * old one is stopped, so an old replica that deleted the webhook on its way out
 * left the bot with none, and Telegram delivered nothing until the next restart.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { asInstanceSlug } from "../../../instances/identifiers.js";

const { setWebhook, deleteWebhook } = vi.hoisted(() => ({ setWebhook: vi.fn(), deleteWebhook: vi.fn() }));
vi.mock("grammy", () => ({
  Bot: class {
    api = { setWebhook, deleteWebhook };
    init = vi.fn(async () => undefined);
    on = vi.fn();
  },
}));

import { TelegramAdapter } from "./index.js";

async function startedAdapter(): Promise<TelegramAdapter> {
  const adapter = new TelegramAdapter(asInstanceSlug("shop"), { botToken: "fixture" }, "https://engine.test/webhooks/telegram/shop");
  await adapter.initialize(vi.fn());
  return adapter;
}

describe("Telegram webhook registration", () => {
  beforeEach(() => {
    setWebhook.mockReset().mockResolvedValue(true);
    deleteWebhook.mockReset().mockResolvedValue(true);
  });

  it("survives the process shutting down", async () => {
    const adapter = await startedAdapter();

    await adapter.shutdown();

    expect(deleteWebhook).not.toHaveBeenCalled();
  });

  it("is removed when the channel is deregistered", async () => {
    const adapter = await startedAdapter();

    await adapter.deregister();

    expect(deleteWebhook).toHaveBeenCalledOnce();
  });
});
