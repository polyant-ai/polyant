// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Who owns the Telegram webhook registration. A bot has exactly one webhook URL,
 * held by Telegram. In a rolling deploy the new replica registers it before the
 * old one is stopped, so an old replica that deleted the webhook on its way out
 * left the bot with none, and Telegram delivered nothing until the next restart.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asInstanceSlug } from "../../../instances/identifiers.js";

const { setWebhook, deleteWebhook, getWebhookInfo } = vi.hoisted(() => ({
  setWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  getWebhookInfo: vi.fn(),
}));
vi.mock("grammy", () => ({
  Bot: class {
    api = { setWebhook, deleteWebhook, getWebhookInfo };
    init = vi.fn(async () => undefined);
    on = vi.fn();
  },
}));

import { TelegramAdapter, WEBHOOK_RETRY_DELAYS_MS } from "./index.js";

const URL = "https://engine.test/webhooks/telegram/shop";

async function startedAdapter(url = URL): Promise<TelegramAdapter> {
  const adapter = new TelegramAdapter(asInstanceSlug("shop"), { botToken: "fixture" }, url);
  await adapter.initialize(vi.fn());
  return adapter;
}

/** What grammY throws for a Bot API error response. */
function botApiError(code: number, retryAfter?: number): Error {
  return Object.assign(new Error(`Call to 'setWebhook' failed! (${code})`), {
    error_code: code,
    ...(retryAfter !== undefined ? { parameters: { retry_after: retryAfter } } : {}),
  });
}

describe("Telegram webhook registration", () => {
  beforeEach(() => {
    setWebhook.mockReset().mockResolvedValue(true);
    deleteWebhook.mockReset().mockResolvedValue(true);
    getWebhookInfo.mockReset().mockResolvedValue({ url: "", allowed_updates: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers this deployment's URL when Telegram holds another", async () => {
    await startedAdapter();
    await vi.waitFor(() => expect(setWebhook).toHaveBeenCalledOnce());
    expect(setWebhook).toHaveBeenCalledWith(URL, expect.objectContaining({ allowed_updates: ["message"] }));
  });

  it("leaves a webhook that already matches alone", async () => {
    getWebhookInfo.mockResolvedValue({ url: URL, allowed_updates: ["message"] });
    await startedAdapter();
    await vi.waitFor(() => expect(getWebhookInfo).toHaveBeenCalledOnce());
    expect(setWebhook).not.toHaveBeenCalled();
  });

  it("starts without registering when the base URL is plain HTTP, instead of failing the channel", async () => {
    // A failed start makes the channel manager disable the channel in the
    // database; an HTTP base URL used to do exactly that to every Telegram bot.
    await expect(startedAdapter("http://engine.test/webhooks/telegram/shop")).resolves.toBeInstanceOf(TelegramAdapter);
    expect(getWebhookInfo).not.toHaveBeenCalled();
    expect(setWebhook).not.toHaveBeenCalled();
  });

  it("starts through a 429 and registers once Telegram allows it again", async () => {
    vi.useFakeTimers();
    setWebhook.mockRejectedValueOnce(botApiError(429, 60)).mockResolvedValueOnce(true);

    await expect(startedAdapter()).resolves.toBeInstanceOf(TelegramAdapter);
    await vi.advanceTimersByTimeAsync(0);
    expect(setWebhook).toHaveBeenCalledTimes(1);

    // Waits the retry_after Telegram named (60 s), longer than the first backoff step.
    expect(WEBHOOK_RETRY_DELAYS_MS[0]).toBeLessThan(60_000);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(setWebhook).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(setWebhook).toHaveBeenCalledTimes(2);
  });

  it("does not retry a request Telegram refuses outright", async () => {
    vi.useFakeTimers();
    setWebhook.mockRejectedValue(botApiError(400));

    await startedAdapter();
    await vi.advanceTimersByTimeAsync(WEBHOOK_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));

    expect(setWebhook).toHaveBeenCalledTimes(1);
  });

  it("stops retrying once the channel is shut down", async () => {
    vi.useFakeTimers();
    setWebhook.mockRejectedValue(new Error("network down"));

    const adapter = await startedAdapter();
    await vi.advanceTimersByTimeAsync(0);
    await adapter.shutdown();
    await vi.advanceTimersByTimeAsync(WEBHOOK_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));

    expect(setWebhook).toHaveBeenCalledTimes(1);
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
