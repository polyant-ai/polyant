// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The retry rule for a caller whose refusals come back as answers rather than
 * errors (a fetch `Response`). The SDK path, where refusals are thrown, is
 * covered against a stand-in Twilio in `twilio-client.retry.test.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import { isNotTakenStatus, parseRetryAfterMs, retryNotTakenSend } from "./twilio-send-retry.js";

interface Answer {
  status: number;
  retryAfter?: string;
}

const readAnswer = (discard: () => Promise<void>) => (outcome: { ok: boolean; value?: Answer }) =>
  outcome.ok && isNotTakenStatus(outcome.value!.status)
    ? { retryAfterMs: parseRetryAfterMs(outcome.value!.retryAfter), discard }
    : undefined;

describe("retryNotTakenSend with answered refusals", () => {
  it("sends again after a 503 answer and frees the refused answer first", async () => {
    const answers: Answer[] = [{ status: 503 }, { status: 201 }];
    const send = vi.fn(async () => answers.shift()!);
    const discard = vi.fn(async () => {});

    const result = await retryNotTakenSend(send, readAnswer(discard));

    expect(result.status).toBe(201);
    expect(send).toHaveBeenCalledTimes(2);
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it("returns a refusal whose Retry-After is past the cap without sending again", async () => {
    const send = vi.fn(async (): Promise<Answer> => ({ status: 429, retryAfter: "120" }));
    const discard = vi.fn(async () => {});

    const result = await retryNotTakenSend(send, readAnswer(discard));

    expect(result.status).toBe(429);
    expect(send).toHaveBeenCalledTimes(1);
    expect(discard).not.toHaveBeenCalled();
  });
});
