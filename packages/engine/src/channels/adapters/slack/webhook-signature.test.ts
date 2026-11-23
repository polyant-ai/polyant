// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { asInstanceSlug } from "../../../instances/identifiers.js";
import { SlackAdapter } from "./index.js";

const sign = (body: Buffer, timestamp: string) =>
  "v0=" + createHmac("sha256", "test-secret").update(`v0:${timestamp}:`).update(body).digest("hex");

const newAdapter = () =>
  new SlackAdapter(asInstanceSlug("agent"), { botToken: "fake-bot-token", signingSecret: "test-secret" });

describe("Slack webhook signature", () => {
  it("signs the raw bytes: two bodies whose invalid UTF-8 decodes alike do not share a signature", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signed = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]); // {"a":"<0xff>"}
    const other = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xfe, 0x22, 0x7d]); // {"a":"<0xfe>"}
    expect(signed.toString("utf8")).toBe(other.toString("utf8"));

    const adapter = newAdapter();
    expect(adapter.verifyRequest(signed, sign(signed, timestamp), timestamp)).toBe(true);
    expect(adapter.verifyRequest(other, sign(signed, timestamp), timestamp)).toBe(false);
  });

  it("rejects a signature of another length or version", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = Buffer.from("{}");
    const adapter = newAdapter();
    expect(adapter.verifyRequest(body, sign(body, timestamp).slice(0, -1), timestamp)).toBe(false);
    expect(adapter.verifyRequest(body, sign(body, timestamp).replace("v0=", "v1="), timestamp)).toBe(false);
  });

  it("accepts the signed raw body and rejects alteration or an old timestamp", () => {
    const adapter = newAdapter();
    const body = Buffer.from('{"type":"event_callback","event":{"type":"app_mention"}}');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(body, timestamp);

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
