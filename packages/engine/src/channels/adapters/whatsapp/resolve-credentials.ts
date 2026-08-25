// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TwilioCredentials } from "./twilio-client.js";

/**
 * Stored WhatsApp channel config. `authMode` is optional because configs
 * written before the API Key feature carry no discriminant — those are Auth
 * Token channels, which is why the field defaults rather than being required.
 */
export interface WhatsAppConfig {
  authMode?: "authToken" | "apiKey";
  accountSid: string;
  authToken?: string;
  apiKeySid?: string;
  apiKeySecret?: string;
  webhookSecret?: string;
  whatsappNumber: string;
}

/**
 * Map a stored channel config onto the credential shape the Twilio client
 * takes. The config schema has already validated that the fields for the
 * selected mode are present (see `channels.store.ts`), so this only picks.
 */
export function resolveTwilioCredentials(cfg: WhatsAppConfig): TwilioCredentials {
  if (cfg.authMode === "apiKey") {
    return {
      mode: "apiKey",
      accountSid: cfg.accountSid,
      apiKeySid: cfg.apiKeySid ?? "",
      apiKeySecret: cfg.apiKeySecret ?? "",
    };
  }
  return { mode: "authToken", accountSid: cfg.accountSid, authToken: cfg.authToken ?? "" };
}
