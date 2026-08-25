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
 * takes.
 *
 * The invariant "the fields for the selected mode are present" holds only
 * for configs that went through `setChannelConfig` (`channels.store.ts`),
 * which parses the payload with the Zod schema before persisting it. It does
 * NOT hold for the read path: `getChannelConfig`/`listChannelConfigs` decrypt
 * straight into `Record<string, unknown>` with no re-validation, and
 * `channel-manager.ts` casts that blindly to `WhatsAppConfig`. A row that
 * predates a field, or one edited directly in the DB, can reach here missing
 * a required credential.
 *
 * So this function does not assume the invariant — a missing field degrades
 * to `""` (via `?? ""`) rather than throwing here. `TwilioWhatsAppClient.create`
 * is what actually rejects the empty string loudly, and `channel-manager.ts`
 * auto-disables the channel in response.
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
