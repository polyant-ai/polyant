// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { asInstanceSlug } from "../../../instances/identifiers.js";
import { SlackAdapter } from "./index.js";

describe("Slack webhook signature", () => {
  it("accepts the signed raw body and rejects alteration or an old timestamp", () => {
    const adapter = new SlackAdapter(asInstanceSlug("agent"), {
      botToken: "xoxb-test",
      signingSecret: "test-secret",
    });
    const body = Buffer.from('{"type":"event_callback","event":{"type":"app_mention"}}');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = "v0=" + createHmac("sha256", "test-secret")
      .update(`v0:${timestamp}:${body.toString("utf8")}`).digest("hex");

    expect(adapter.verifyRequest(body, signature, timestamp)).toBe(true);
    expect(adapter.verifyRequest(Buffer.from("{}"), signature, timestamp)).toBe(false);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 301_000);
      expect(adapter.verifyRequest(body, signature, timestamp)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
