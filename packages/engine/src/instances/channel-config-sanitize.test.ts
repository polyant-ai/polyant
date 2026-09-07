// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { stripSensitiveKeys } from "./channel-config-sanitize.js";

describe("stripSensitiveKeys", () => {
  it("should_remove_credential_like_keys_case_insensitively", () => {
    const stripped = stripSensitiveKeys({
      botToken: "123:secret",
      appToken: "xapp-1",
      signingSecret: "shh",
      apiKey: "k",
      password: "p",
      myCredential: "c",
      allowedUserIds: "1,2,3",
      whatsappNumber: "+14155238886",
    });

    // Secret-bearing keys are gone.
    expect(stripped).not.toHaveProperty("botToken");
    expect(stripped).not.toHaveProperty("appToken");
    expect(stripped).not.toHaveProperty("signingSecret");
    expect(stripped).not.toHaveProperty("apiKey");
    expect(stripped).not.toHaveProperty("password");
    expect(stripped).not.toHaveProperty("myCredential");

    // Non-secret settings survive.
    expect(stripped).toEqual({
      allowedUserIds: "1,2,3",
      whatsappNumber: "+14155238886",
    });
  });

  it("should_return_an_empty_object_for_the_credential_less_agent_config", () => {
    expect(stripSensitiveKeys({})).toEqual({});
  });

  it("should_keep_the_whatsapp_authMode_discriminant_but_strip_its_credentials", () => {
    const stripped = stripSensitiveKeys({
      authMode: "apiKey",
      accountSid: "AC00000000000000000000000000000001",
      apiKeySid: "SK00000000000000000000000000000002",
      apiKeySecret: "sec",
      webhookSecret: "deadbeef",
      whatsappNumber: "+14155238886",
    });

    // The discriminant must survive: a bundle that loses it silently reimports
    // as an authToken channel. This is why the field is not called
    // "credentialMode" — that would match the sensitive-key pattern.
    expect(stripped).toEqual({
      authMode: "apiKey",
      accountSid: "AC00000000000000000000000000000001",
      whatsappNumber: "+14155238886",
    });
  });
});
