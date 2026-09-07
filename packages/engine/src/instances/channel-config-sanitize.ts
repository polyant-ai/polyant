// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Channel config sanitization — single responsibility, shared both ways
// ---------------------------------------------------------------------------
//
// Credential-like config keys, stripped on BOTH sides of an instance bundle:
// `export.service.ts` strips them before a channel config leaves the database,
// and `import.service.ts` strips them again before a channel config coming
// FROM a bundle (untrusted — it may have been hand-edited) is
// validated/persisted. Applying the same pattern on import means a
// hand-crafted bundle can never smuggle a credential (e.g. a caller-chosen
// `webhookSecret` for the WhatsApp `apiKey` inbound-auth route) back into
// storage — see the NOTE on `setChannelConfig` in `channels.store.ts` for the
// exploit this closes. Living in its own module (rather than in either
// export or import service) avoids making one of those two services depend
// on the other just to reuse this pattern.

/** Credential-like config keys — matched case-insensitively. */
const SENSITIVE_KEY_PATTERN = /(?:token|secret|password|key|credential)/i;

/** Return a copy of `config` with credential-like keys removed. */
export function stripSensitiveKeys(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config).filter(([key]) => !SENSITIVE_KEY_PATTERN.test(key)),
  );
}
