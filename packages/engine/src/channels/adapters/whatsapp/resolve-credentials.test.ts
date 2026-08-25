// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { resolveTwilioCredentials } from "./resolve-credentials.js";

const ACCOUNT_SID = "AC00000000000000000000000000000001";
const API_KEY_SID = "SK00000000000000000000000000000002";

describe("resolveTwilioCredentials", () => {
  it("should_treat_a_config_without_authMode_as_authToken", () => {
    expect(
      resolveTwilioCredentials({ accountSid: ACCOUNT_SID, authToken: "tok", whatsappNumber: "+14155238886" }),
    ).toEqual({ mode: "authToken", accountSid: ACCOUNT_SID, authToken: "tok" });
  });

  it("should_resolve_an_explicit_authToken_config", () => {
    expect(
      resolveTwilioCredentials({
        authMode: "authToken",
        accountSid: ACCOUNT_SID,
        authToken: "tok",
        whatsappNumber: "+14155238886",
      }),
    ).toEqual({ mode: "authToken", accountSid: ACCOUNT_SID, authToken: "tok" });
  });

  it("should_resolve_an_apiKey_config", () => {
    expect(
      resolveTwilioCredentials({
        authMode: "apiKey",
        accountSid: ACCOUNT_SID,
        apiKeySid: API_KEY_SID,
        apiKeySecret: "sec",
        webhookSecret: "deadbeef",
        whatsappNumber: "+14155238886",
      }),
    ).toEqual({ mode: "apiKey", accountSid: ACCOUNT_SID, apiKeySid: API_KEY_SID, apiKeySecret: "sec" });
  });
});
