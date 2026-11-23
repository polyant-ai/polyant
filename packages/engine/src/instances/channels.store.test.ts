// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The channel config keys the panel may read and write. What the store saves and
 * reads is tested against Postgres in `channels.store.integration.test.ts`;
 * WhatsApp credential modes live in `channels.store.whatsapp.integration.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { CHANNEL_TYPES, CHANNEL_CONFIG_KEYS } from "./channels.store.js";

describe("CHANNEL_CONFIG_KEYS", () => {
  it("should_cover_every_channel_type", () => {
    expect(Object.keys(CHANNEL_CONFIG_KEYS).sort()).toEqual([...CHANNEL_TYPES].sort());
  });

  it("should_not_expose_the_server_generated_webhook_secret", () => {
    expect(CHANNEL_CONFIG_KEYS.whatsapp).not.toContain("webhookSecret");
    expect(CHANNEL_CONFIG_KEYS.telegram).not.toContain("webhookSecret");
  });
});
