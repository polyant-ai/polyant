# WhatsApp Twilio API Key Authentication — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the WhatsApp channel authenticate to Twilio with either the account Auth Token or an API Key (`SK…` + secret), and authenticate inbound webhooks without an Auth Token.

**Architecture:** The channel config becomes a Zod discriminated union on a new `authMode` field. `TwilioWhatsAppClient` takes a normalized credentials object and resolves the SDK constructor plus one shared Basic-auth header from it. Inbound gets a second route carrying a server-generated `webhookSecret` in the path, gated by a constant-time digest comparison; the signature-validated route stays byte-identical for `authToken` channels.

**Tech Stack:** TypeScript ESM, NestJS 11, Zod 3, Drizzle, vitest; Next.js 16 + React 19 + shadcn/ui for the admin panel.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-24-whatsapp-api-key-auth-design.md`. Read it before starting.
- Base branch is `main` (hotfix). Work on `fix/whatsapp-api-key-auth`. Never target `develop`.
- Every commit needs a DCO trailer: `Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>`. Multi-line `-m` corrupts newlines in this shell — write the message to a file and use `git commit -F <file>`.
- All repo artifacts (code, comments, docs, commit messages) in English.
- Relative imports end in `.js` (ESM). Named exports only. Files kebab-case.
- No DB migration. No new environment variable.
- `webhookSecret` is NEVER accepted from a request body and NEVER logged.
- No behaviour change for a channel whose stored config has no `authMode`.
- Canonical test fixtures (real Twilio SIDs are `AC`/`SK` + 32 hex chars):
  - Account SID: `AC00000000000000000000000000000001`
  - API Key SID: `SK00000000000000000000000000000002`
  - WhatsApp number: `+14155238886`

---

### Task 1: Record the test baseline

The local checkout is missing `@polyant-ai/plugin-sdk` and `radix-ui`, so a slice of the suite fails to *collect* on any branch. Without a baseline, those failures get misread as regressions caused by this work.

**Files:**
- Create: `/tmp/whatsapp-apikey-baseline.txt` (scratch, not committed)

- [ ] **Step 1: Try to repair the local dependency tree**

```bash
npm install
```

Expected: either it succeeds (best case — the whole suite then collects), or it fails on the `@polyant-ai/plugin-sdk` git dependency. Either outcome is fine; just note which happened.

- [ ] **Step 2: Record the engine baseline**

```bash
npm run test -w @polyant/engine 2>&1 | tail -40 > /tmp/whatsapp-apikey-baseline.txt
```

- [ ] **Step 3: Record the web baseline**

```bash
npm run test -w @polyant/web 2>&1 | tail -40 >> /tmp/whatsapp-apikey-baseline.txt
```

- [ ] **Step 4: Read the file and write down the two totals**

```bash
cat /tmp/whatsapp-apikey-baseline.txt
```

Note the "Tests" and "Test Files" counts for engine and web. Every later task compares against these numbers. A pre-existing failure is NOT yours to fix; a *new* failure is.

Nothing to commit in this task.

---

### Task 2: Config schema — `authMode` discriminated union + allowlist backport

**Files:**
- Modify: `packages/engine/src/instances/channels.store.ts:44-76`
- Test: `packages/engine/src/instances/channels.store.test.ts`

**Interfaces:**
- Produces:
  - `WHATSAPP_AUTH_MODES: readonly ["authToken", "apiKey"]`
  - `type WhatsAppAuthMode = "authToken" | "apiKey"`
  - `CHANNEL_CONFIG_KEYS: Record<ChannelType, readonly string[]>`
  - `pruneWhatsAppCredentials(config: Record<string, unknown>): Record<string, unknown>`
  - `resolveWhatsAppAuthMode(config: Record<string, unknown>): WhatsAppAuthMode`

- [ ] **Step 1: Write the failing tests**

Append this `describe` block to `packages/engine/src/instances/channels.store.test.ts`, and add `CHANNEL_CONFIG_KEYS, channelConfigSchemas, pruneWhatsAppCredentials, resolveWhatsAppAuthMode` to the existing import of `./channels.store.js` in that file.

```ts
describe("whatsapp credential modes", () => {
  const ACCOUNT_SID = "AC00000000000000000000000000000001";
  const API_KEY_SID = "SK00000000000000000000000000000002";
  const NUMBER = "+14155238886";

  it("should_accept_an_auth_token_config", () => {
    const parsed = channelConfigSchemas.whatsapp.parse({
      authMode: "authToken",
      accountSid: ACCOUNT_SID,
      authToken: "tok",
      whatsappNumber: NUMBER,
    });
    expect(parsed).toMatchObject({ authMode: "authToken", authToken: "tok" });
  });

  it("should_default_a_legacy_config_without_authMode_to_authToken", () => {
    const parsed = channelConfigSchemas.whatsapp.parse({
      accountSid: ACCOUNT_SID,
      authToken: "tok",
      whatsappNumber: NUMBER,
    });
    expect(parsed).toMatchObject({ authMode: "authToken" });
  });

  it("should_accept_an_api_key_config", () => {
    const parsed = channelConfigSchemas.whatsapp.parse({
      authMode: "apiKey",
      accountSid: ACCOUNT_SID,
      apiKeySid: API_KEY_SID,
      apiKeySecret: "sec",
      webhookSecret: "deadbeef",
      whatsappNumber: NUMBER,
    });
    expect(parsed).toMatchObject({ authMode: "apiKey", apiKeySid: API_KEY_SID });
  });

  it("should_reject_an_api_key_config_without_a_webhook_secret", () => {
    expect(() =>
      channelConfigSchemas.whatsapp.parse({
        authMode: "apiKey",
        accountSid: ACCOUNT_SID,
        apiKeySid: API_KEY_SID,
        apiKeySecret: "sec",
        whatsappNumber: NUMBER,
      }),
    ).toThrow();
  });

  it("should_reject_an_account_sid_that_is_actually_an_api_key_sid", () => {
    expect(() =>
      channelConfigSchemas.whatsapp.parse({
        authMode: "authToken",
        accountSid: API_KEY_SID,
        authToken: "tok",
        whatsappNumber: NUMBER,
      }),
    ).toThrow();
  });

  it("should_trim_pasted_credentials", () => {
    const parsed = channelConfigSchemas.whatsapp.parse({
      authMode: "authToken",
      accountSid: ` ${ACCOUNT_SID} `,
      authToken: " tok\n",
      whatsappNumber: ` ${NUMBER} `,
    });
    expect(parsed).toMatchObject({ accountSid: ACCOUNT_SID, authToken: "tok", whatsappNumber: NUMBER });
  });

  it("should_prune_api_key_fields_when_the_mode_is_authToken", () => {
    const pruned = pruneWhatsAppCredentials({
      authMode: "authToken",
      accountSid: ACCOUNT_SID,
      authToken: "tok",
      apiKeySid: API_KEY_SID,
      apiKeySecret: "sec",
      webhookSecret: "deadbeef",
      whatsappNumber: NUMBER,
    });
    expect(pruned).toEqual({
      authMode: "authToken",
      accountSid: ACCOUNT_SID,
      authToken: "tok",
      whatsappNumber: NUMBER,
    });
  });

  it("should_prune_the_auth_token_when_the_mode_is_apiKey", () => {
    const pruned = pruneWhatsAppCredentials({
      authMode: "apiKey",
      accountSid: ACCOUNT_SID,
      authToken: "tok",
      apiKeySid: API_KEY_SID,
      apiKeySecret: "sec",
      webhookSecret: "deadbeef",
      whatsappNumber: NUMBER,
    });
    expect(pruned).not.toHaveProperty("authToken");
    expect(pruned).toMatchObject({ apiKeySid: API_KEY_SID, webhookSecret: "deadbeef" });
  });

  it("should_resolve_a_missing_authMode_to_authToken", () => {
    expect(resolveWhatsAppAuthMode({ accountSid: ACCOUNT_SID })).toBe("authToken");
    expect(resolveWhatsAppAuthMode({ authMode: "apiKey" })).toBe("apiKey");
    expect(resolveWhatsAppAuthMode({ authMode: "nonsense" })).toBe("authToken");
  });
});

describe("CHANNEL_CONFIG_KEYS", () => {
  it("should_cover_every_channel_type", () => {
    expect(Object.keys(CHANNEL_CONFIG_KEYS).sort()).toEqual([...CHANNEL_TYPES].sort());
  });

  it("should_not_expose_the_server_generated_webhook_secret", () => {
    expect(CHANNEL_CONFIG_KEYS.whatsapp).not.toContain("webhookSecret");
  });

  it("should_accept_both_credential_modes_for_whatsapp", () => {
    expect(CHANNEL_CONFIG_KEYS.whatsapp).toEqual([
      "authMode",
      "accountSid",
      "authToken",
      "apiKeySid",
      "apiKeySecret",
      "whatsappNumber",
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test -w @polyant/engine -- src/instances/channels.store.test.ts
```

Expected: FAIL — `channelConfigSchemas`, `CHANNEL_CONFIG_KEYS`, `pruneWhatsAppCredentials` and `resolveWhatsAppAuthMode` are not exported (`SyntaxError` / `is not a function`).

- [ ] **Step 3: Implement the schema**

In `packages/engine/src/instances/channels.store.ts`, replace the `whatsapp:` entry of `channelConfigSchemas` (lines 55-59) with `whatsapp: whatsappConfigSchema,` and insert the following block immediately ABOVE the `channelConfigSchemas` declaration:

```ts
/**
 * Twilio accepts two credential shapes for the same account, and an operator
 * may hold only one of them:
 *   - `authToken` — the account's Auth Token. Also the ONLY key Twilio uses to
 *     sign inbound webhooks (HMAC-SHA1), so this mode keeps signature checks.
 *   - `apiKey` — a revocable API Key (`SK…` + secret). Twilio publishes no
 *     API-Key-keyed webhook signature, so this mode authenticates inbound with
 *     `webhookSecret` (server-generated, carried in the webhook path).
 */
export const WHATSAPP_AUTH_MODES = ["authToken", "apiKey"] as const;
export type WhatsAppAuthMode = (typeof WHATSAPP_AUTH_MODES)[number];

/** Twilio SID formats: a 2-letter prefix followed by 32 hex characters. */
const ACCOUNT_SID_PATTERN = /^AC[0-9a-fA-F]{32}$/;
const API_KEY_SID_PATTERN = /^SK[0-9a-fA-F]{32}$/;

const accountSidSchema = z
  .string()
  .trim()
  .regex(ACCOUNT_SID_PATTERN, "accountSid must be a Twilio Account SID (AC followed by 32 hex characters)");
const whatsappNumberSchema = z.string().trim().regex(/^\+\d+$/);

const whatsappAuthTokenConfig = z.object({
  authMode: z.literal("authToken"),
  accountSid: accountSidSchema,
  authToken: z.string().trim().min(1),
  whatsappNumber: whatsappNumberSchema,
});

const whatsappApiKeyConfig = z.object({
  authMode: z.literal("apiKey"),
  accountSid: accountSidSchema,
  apiKeySid: z
    .string()
    .trim()
    .regex(API_KEY_SID_PATTERN, "apiKeySid must be a Twilio API Key SID (SK followed by 32 hex characters)"),
  apiKeySecret: z.string().trim().min(1),
  // Server-generated (see CHANNEL_CONFIG_KEYS): required here so a config in
  // this mode can never be stored without an inbound authentication gate.
  webhookSecret: z.string().trim().min(1),
  whatsappNumber: whatsappNumberSchema,
});

/**
 * Configs stored before this feature carry no `authMode`. Defaulting it to
 * `authToken` here keeps every existing agent — and every existing Management
 * API caller that PUTs the three legacy keys — working unchanged.
 */
const whatsappConfigSchema = z.preprocess(
  (value) =>
    typeof value === "object" && value !== null && !("authMode" in value)
      ? { authMode: "authToken", ...value }
      : value,
  z.discriminatedUnion("authMode", [whatsappAuthTokenConfig, whatsappApiKeyConfig]),
);

/** Config keys that belong to exactly one WhatsApp credential mode. */
const WHATSAPP_MODE_ONLY_KEYS: Record<WhatsAppAuthMode, readonly string[]> = {
  authToken: ["authToken"],
  apiKey: ["apiKeySid", "apiKeySecret", "webhookSecret"],
};

/** The stored mode, tolerating a legacy config that predates the field. */
export function resolveWhatsAppAuthMode(config: Record<string, unknown>): WhatsAppAuthMode {
  return config.authMode === "apiKey" ? "apiKey" : "authToken";
}

/**
 * Drop the credentials of the mode NOT in use. Without this, switching mode
 * would leave the discarded credential encrypted at rest forever.
 */
export function pruneWhatsAppCredentials(config: Record<string, unknown>): Record<string, unknown> {
  const mode = resolveWhatsAppAuthMode(config);
  const discard = mode === "apiKey" ? WHATSAPP_MODE_ONLY_KEYS.authToken : WHATSAPP_MODE_ONLY_KEYS.apiKey;
  return Object.fromEntries(Object.entries(config).filter(([key]) => !discard.includes(key)));
}
```

- [ ] **Step 4: Backport the config-key allowlist**

Insert immediately BELOW the closing `};` of `channelConfigSchemas`:

```ts
/**
 * The config keys each channel type accepts from the management API — the
 * allowlist the PUT handler iterates instead of iterating the request body, so
 * no property name written into a stored config can come from remote input.
 *
 * `webhookSecret` is deliberately ABSENT: it is minted server-side, and letting
 * a caller supply it would defeat that.
 *
 * `agent` is deliberately empty. Its Zod schema is open-passthrough to leave
 * room for future per-pair policies, but no such key is consumed today.
 *
 * Keep in sync with `channelConfigSchemas` above (guarded by a unit test).
 */
export const CHANNEL_CONFIG_KEYS: Record<ChannelType, readonly string[]> = {
  telegram: ["botToken", "allowedUserIds"],
  slack: ["botToken", "appToken", "signingSecret"],
  whatsapp: ["authMode", "accountSid", "authToken", "apiKeySid", "apiKeySecret", "whatsappNumber"],
  agent: [],
};
```

- [ ] **Step 5: Update the pre-existing whatsapp fixtures**

Three existing tests in `channels.store.test.ts` use short fake SIDs (`"AC123"`, `"AC1"`) that the new regex rejects. This is an intentional behaviour change (TEST OUTDATED, not a regression): replace the SIDs, keeping each test's intent.

- line ~160: `const config = { accountSid: "AC00000000000000000000000000000001", authToken: "token", whatsappNumber: "+14155238886" };`
- line ~194: `{ accountSid: "AC00000000000000000000000000000001", authToken: "tok", whatsappNumber: "nope" }` (still invalid — the number is what this test asserts on)
- line ~186 needs no change: it omits `accountSid` and must still throw.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm run test -w @polyant/engine -- src/instances/channels.store.test.ts
```

Expected: PASS, all tests in the file.

- [ ] **Step 7: Typecheck**

```bash
npm run typecheck -w @polyant/engine
```

Expected: no errors. `setChannelConfig` still takes `Record<string, unknown>`, so no call site changes.

- [ ] **Step 8: Commit**

```bash
cat > /tmp/msg.txt <<'EOF'
feat(whatsapp): model Twilio credentials as an authMode union

The WhatsApp channel accepted only an Auth Token. Twilio also issues
revocable API Keys (SK + secret), which an operator may hold instead.

Config becomes a discriminated union on a new authMode field, with the
API Key variant additionally carrying a server-generated webhookSecret
(Twilio signs webhooks with the Auth Token only, so that mode needs its
own inbound gate). A missing authMode is preprocessed to authToken, so
stored configs and existing Management API callers are unaffected.

accountSid is now format-checked (AC + 32 hex): putting an API Key SID
there used to fail only later, inside the Twilio SDK constructor.

Also backports the CHANNEL_CONFIG_KEYS allowlist from develop, so the
PUT handler can walk known keys instead of the request body and the
server-minted webhookSecret can never be client-supplied.

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
EOF
git add packages/engine/src/instances/channels.store.ts packages/engine/src/instances/channels.store.test.ts
git commit -F /tmp/msg.txt
```

---

### Task 3: Twilio client — two credential modes

**Files:**
- Modify: `packages/engine/src/channels/adapters/whatsapp/twilio-client.ts:11-35,84,102-104,125`
- Test: `packages/engine/src/channels/adapters/whatsapp/twilio-client.test.ts`

**Interfaces:**
- Consumes: nothing from Task 2 (the client stays free of the config schema).
- Produces:
  - `type TwilioCredentials = { mode: "authToken"; accountSid: string; authToken: string } | { mode: "apiKey"; accountSid: string; apiKeySid: string; apiKeySecret: string }`
  - `TwilioWhatsAppClient.create(credentials: TwilioCredentials, whatsappNumber: string): TwilioWhatsAppClient`
  - `client.validateWebhook(signature, url, params): boolean` — throws in `apiKey` mode.

- [ ] **Step 1: Migrate the existing call sites in the test**

`create()` changes from three positional arguments to `(credentials, number)`. All 17 existing call sites in the test file pass the same values, so this is mechanical:

```bash
perl -pi -e 's/TwilioWhatsAppClient\.create\("AC123", "token123", /TwilioWhatsAppClient.create({ mode: "authToken", accountSid: "AC123", authToken: "token123" }, /g' packages/engine/src/channels/adapters/whatsapp/twilio-client.test.ts
```

Then fix the four remaining hand-written cases (lines ~33-47) by hand:

```ts
    it("creates a client with valid credentials", () => {
      const client = TwilioWhatsAppClient.create(
        { mode: "authToken", accountSid: "AC123", authToken: "token123" },
        "+14155238886",
      );
      expect(client).toBeDefined();
    });

    it("throws without an accountSid", () => {
      expect(() =>
        TwilioWhatsAppClient.create({ mode: "authToken", accountSid: "", authToken: "token" }, "+14155238886"),
      ).toThrow();
    });

    it("throws without an authToken", () => {
      expect(() =>
        TwilioWhatsAppClient.create({ mode: "authToken", accountSid: "AC123", authToken: "" }, "+14155238886"),
      ).toThrow();
    });

    it("throws on a malformed whatsapp number", () => {
      expect(() =>
        TwilioWhatsAppClient.create({ mode: "authToken", accountSid: "AC123", authToken: "token" }, "14155238886"),
      ).toThrow();
    });
```

Note: these keep the short `AC123` fixture on purpose. The client validates presence, not format — format is the config layer's job (Task 2).

- [ ] **Step 2: Write the failing tests for the new mode**

Append inside the top-level `describe("TwilioWhatsAppClient", …)`:

```ts
  describe("apiKey mode", () => {
    const API_KEY_CREDENTIALS = {
      mode: "apiKey" as const,
      accountSid: "AC00000000000000000000000000000001",
      apiKeySid: "SK00000000000000000000000000000002",
      apiKeySecret: "secret-value",
    };

    it("passes the accountSid to the SDK as a separate option", async () => {
      TwilioWhatsAppClient.create(API_KEY_CREDENTIALS, "+14155238886");

      // The Node SDK rejects a username that is not an AC-SID unless the
      // account is supplied separately, and builds REST paths from it.
      const Twilio = (await import("twilio")).default as unknown as ReturnType<typeof vi.fn>;
      expect(Twilio).toHaveBeenCalledWith(
        "SK00000000000000000000000000000002",
        "secret-value",
        { accountSid: "AC00000000000000000000000000000001" },
      );
    });

    it("signs hand-rolled Basic auth with the api key, not the account sid", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", fetchMock);

      const client = TwilioWhatsAppClient.create(API_KEY_CREDENTIALS, "+14155238886");
      await client.sendTypingIndicator("SM123");

      const expected = Buffer.from(
        "SK00000000000000000000000000000002:secret-value",
      ).toString("base64");
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Basic ${expected}`);

      vi.unstubAllGlobals();
    });

    it("refuses to validate a webhook signature", () => {
      const client = TwilioWhatsAppClient.create(API_KEY_CREDENTIALS, "+14155238886");
      expect(() => client.validateWebhook("sig", "https://example.com/hook", {})).toThrow(
        /auth token/i,
      );
    });

    it("throws without an apiKeySecret", () => {
      expect(() =>
        TwilioWhatsAppClient.create({ ...API_KEY_CREDENTIALS, apiKeySecret: "" }, "+14155238886"),
      ).toThrow();
    });
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npm run test -w @polyant/engine -- src/channels/adapters/whatsapp/twilio-client.test.ts
```

Expected: FAIL — `create` still expects three positional arguments; `validateWebhook` does not throw.

- [ ] **Step 4: Implement the two modes**

Replace lines 11-35 of `twilio-client.ts` (the field declarations, constructor and `create`) with:

```ts
/**
 * The two credential shapes Twilio accepts for one account. `apiKey` is a
 * revocable key pair; it can drive every REST call but CANNOT validate an
 * inbound webhook signature, which Twilio keys on the account Auth Token.
 */
export type TwilioCredentials =
  | { mode: "authToken"; accountSid: string; authToken: string }
  | { mode: "apiKey"; accountSid: string; apiKeySid: string; apiKeySecret: string };

export class TwilioWhatsAppClient {
  private readonly client: ReturnType<typeof Twilio>;
  private readonly credentials: TwilioCredentials;
  private readonly fromNumber: string;
  /**
   * In-memory cache of resolved template definitions, keyed by contentSid.
   * Approved WhatsApp templates are immutable post-approval, so a process-
   * lifetime cache is safe. Errors are NOT cached (transient failures must
   * not pin a missing template).
   */
  private readonly templateCache = new Map<string, TemplateDefinition>();

  private constructor(credentials: TwilioCredentials, whatsappNumber: string) {
    this.client =
      credentials.mode === "apiKey"
        ? // An API Key SID goes in the username slot; the SDK needs the account
          // separately because it builds `/Accounts/{AC…}/…` REST paths and
          // rejects any username-derived SID that does not start with `AC`.
          Twilio(credentials.apiKeySid, credentials.apiKeySecret, { accountSid: credentials.accountSid })
        : Twilio(credentials.accountSid, credentials.authToken);
    this.credentials = credentials;
    this.fromNumber = whatsappNumber;
  }

  static create(credentials: TwilioCredentials, whatsappNumber: string): TwilioWhatsAppClient {
    if (!credentials.accountSid) throw new Error("accountSid is required");
    if (credentials.mode === "apiKey") {
      if (!credentials.apiKeySid) throw new Error("apiKeySid is required");
      if (!credentials.apiKeySecret) throw new Error("apiKeySecret is required");
    } else if (!credentials.authToken) {
      throw new Error("authToken is required");
    }
    if (!/^\+\d+$/.test(whatsappNumber)) throw new Error("whatsappNumber must start with + followed by digits");
    return new TwilioWhatsAppClient(credentials, whatsappNumber);
  }

  /**
   * Base64 `user:pass` for the endpoints called with `fetch` rather than through
   * the SDK (typing indicator, Content API, media download), so the credential
   * mode is resolved in a single place.
   *
   * Two accessors because the consumers differ: `media-fetch.ts` prefixes
   * `Basic ` itself and needs the bare value.
   */
  basicAuthValue(): string {
    const [user, pass] =
      this.credentials.mode === "apiKey"
        ? [this.credentials.apiKeySid, this.credentials.apiKeySecret]
        : [this.credentials.accountSid, this.credentials.authToken];
    return Buffer.from(`${user}:${pass}`).toString("base64");
  }

  basicAuthHeader(): string {
    return `Basic ${this.basicAuthValue()}`;
  }
```

- [ ] **Step 5: Route the three hand-rolled headers through the accessor**

In `sendTypingIndicator` (was line 84) replace:

```ts
    const credentials = Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64");
```

and its use `Authorization: \`Basic ${credentials}\`` with:

```ts
        Authorization: this.basicAuthHeader(),
```

Apply the same replacement in `getTemplateContent` (was line 125).

Then replace `validateWebhook` (was lines 102-104) with:

```ts
  /**
   * Validate an inbound webhook signature. Twilio computes it as HMAC-SHA1
   * keyed with the account Auth Token and publishes no API-Key-keyed variant,
   * so this is structurally unavailable in `apiKey` mode — that mode
   * authenticates inbound with a path secret instead (see the Twilio webhook
   * controller). Throwing here rather than returning false keeps a
   * misconfiguration loud instead of silently rejecting every message.
   */
  validateWebhook(signature: string, url: string, params: Record<string, string>): boolean {
    if (this.credentials.mode !== "authToken") {
      throw new Error("Signature validation requires an auth token; this channel uses an API key");
    }
    return Twilio.validateRequest(this.credentials.authToken, signature, url, params);
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm run test -w @polyant/engine -- src/channels/adapters/whatsapp/twilio-client.test.ts
```

Expected: PASS, all tests in the file (17 migrated + 4 new).

- [ ] **Step 7: Commit**

```bash
cat > /tmp/msg.txt <<'EOF'
feat(whatsapp): drive the Twilio client from either credential mode

create() now takes a normalized TwilioCredentials object instead of
three positional arguments, so the SDK constructor and the three
hand-rolled Basic headers (typing indicator, Content API, media
download) resolve the mode in one place each.

In apiKey mode the SDK gets the API Key SID as the username plus the
account SID as a separate option, which is what it requires to build
REST paths. validateWebhook throws in that mode: Twilio keys webhook
signatures on the Auth Token, so the alternative is a silent reject of
every inbound message.

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
EOF
git add packages/engine/src/channels/adapters/whatsapp/twilio-client.ts packages/engine/src/channels/adapters/whatsapp/twilio-client.test.ts
git commit -F /tmp/msg.txt
```

---

### Task 4: Adapter — normalize stored config into credentials

**Files:**
- Modify: `packages/engine/src/channels/adapters/whatsapp/index.ts:11-14,26-34,119-124,199-203`
- Create: `packages/engine/src/channels/adapters/whatsapp/resolve-credentials.ts`
- Test: `packages/engine/src/channels/adapters/whatsapp/resolve-credentials.test.ts`

**Interfaces:**
- Consumes: `TwilioCredentials`, `TwilioWhatsAppClient.create`, `client.basicAuthHeader()` (Task 3).
- Produces:
  - `resolveTwilioCredentials(cfg: WhatsAppConfig): TwilioCredentials`
  - `WhatsAppConfig` widened to both modes.

- [ ] **Step 1: Write the failing test**

Create `packages/engine/src/channels/adapters/whatsapp/resolve-credentials.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test -w @polyant/engine -- src/channels/adapters/whatsapp/resolve-credentials.test.ts
```

Expected: FAIL — `Failed to resolve import "./resolve-credentials.js"`.

- [ ] **Step 3: Implement the resolver**

Create `packages/engine/src/channels/adapters/whatsapp/resolve-credentials.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run test -w @polyant/engine -- src/channels/adapters/whatsapp/resolve-credentials.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Wire the adapter**

In `packages/engine/src/channels/adapters/whatsapp/index.ts`:

Delete the local `WhatsAppConfig` interface (lines 11-14) and import both the type and the resolver instead — add next to the existing imports:

```ts
import { resolveTwilioCredentials, type WhatsAppConfig } from "./resolve-credentials.js";
```

Re-export the type so existing importers (`channel-manager.ts`) keep compiling:

```ts
export type { WhatsAppConfig };
```

Replace the client construction in `initialize` (lines 28-32):

```ts
    this.client = TwilioWhatsAppClient.create(
      resolveTwilioCredentials(this.cfg),
      this.cfg.whatsappNumber,
    );
```

Replace the Basic header in `downloadMedia` (line 121). `fetchMediaFollowingRedirects` prefixes `Basic ` itself (`media-fetch.ts:68`), so pass the BARE base64:

```ts
      if (!this.client) return null;
      const res = await fetchMediaFollowingRedirects(url, this.client.basicAuthValue());
```

Finally make `validateSignature` (lines 199-203) tolerate the throwing client:

```ts
  /** Validate a Twilio webhook signature. Returns false when this channel uses
   *  an API key, which cannot validate signatures — the webhook controller
   *  routes those channels to the path-secret gate instead and never calls
   *  this. */
  validateSignature(signature: string, url: string, params: Record<string, string>): boolean {
    if (!this.client) return false;
    try {
      return this.client.validateWebhook(signature, url, params);
    } catch {
      return false;
    }
  }
```

- [ ] **Step 6: Verify the whole adapter suite and typecheck**

```bash
npm run test -w @polyant/engine -- src/channels/
npm run typecheck -w @polyant/engine
```

Expected: PASS / no errors.

- [ ] **Step 7: Commit**

```bash
cat > /tmp/msg.txt <<'EOF'
feat(whatsapp): resolve stored config into Twilio credentials

The adapter now maps its stored config onto the client's credential
object through a dedicated resolver, which defaults a config without
authMode to authToken so pre-existing channels are untouched.

Media download takes its Basic header from the client accessor instead
of rebuilding it from accountSid/authToken, and validateSignature
degrades to false for an API Key channel rather than propagating the
client's throw (that channel is authenticated by path secret, so this
path is not reached in practice).

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
EOF
git add packages/engine/src/channels/adapters/whatsapp/
git commit -F /tmp/msg.txt
```

---

### Task 5: Inbound — path-secret route

**Files:**
- Modify: `packages/engine/src/server/channels/twilio-webhook.controller.ts`
- Test: `packages/engine/src/server/channels/twilio-webhook.controller.test.ts`

**Interfaces:**
- Consumes: `resolveWhatsAppAuthMode` (Task 2).
- Produces: `controller.handleWhatsAppWebhookWithSecret(instanceSlug, webhookSecret, body): Promise<string>`; the existing `handleWhatsAppWebhook(instanceSlug, signature, body, req)` keeps its signature.

- [ ] **Step 1: Write the failing tests**

Add to the mock of `../../instances/channels.store.js` at the top of the test file the function the controller now imports:

```ts
vi.mock("../../instances/channels.store.js", () => ({
  getChannelConfig: mockGetChannelConfig,
  // Keep in sync with the real tuple in instances/channels.store.ts —
  // any new API-configurable channel type must be added here.
  CHANNEL_TYPES: ["telegram", "slack", "whatsapp", "agent"],
  resolveWhatsAppAuthMode: (cfg: Record<string, unknown>) =>
    cfg.authMode === "apiKey" ? "apiKey" : "authToken",
}));
```

Then append this `describe` inside the top-level one:

```ts
  describe("apiKey mode (path secret)", () => {
    const SECRET = "0123456789abcdef0123456789abcdef";

    beforeEach(() => {
      mockGetChannelConfig.mockResolvedValue({
        channelType: "whatsapp",
        enabled: true,
        config: {
          authMode: "apiKey",
          accountSid: "AC00000000000000000000000000000001",
          apiKeySid: "SK00000000000000000000000000000002",
          apiKeySecret: "sec",
          webhookSecret: SECRET,
          whatsappNumber: "+14155238886",
        },
      });
    });

    it("processes an inbound message when the secret matches", async () => {
      const result = await controller.handleWhatsAppWebhookWithSecret("test-instance", SECRET, validBody);

      expect(result).toBe("<Response/>");
      expect(mockAdapter.validateSignature).not.toHaveBeenCalled();
      expect(mockAdapter.handleInbound).toHaveBeenCalledWith(
        expect.objectContaining({ from: "+393331234567", body: "Hello agent", messageSid: "SM123" }),
      );
    });

    it("rejects a wrong secret without processing the message", async () => {
      await expect(
        controller.handleWhatsAppWebhookWithSecret("test-instance", "wrong-secret", validBody),
      ).rejects.toThrow();
      expect(mockAdapter.handleInbound).not.toHaveBeenCalled();
    });

    it("rejects a secret of a different length (no length oracle)", async () => {
      await expect(
        controller.handleWhatsAppWebhookWithSecret("test-instance", "short", validBody),
      ).rejects.toThrow();
    });

    it("never logs the secret", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await expect(
        controller.handleWhatsAppWebhookWithSecret("test-instance", "wrong-secret", validBody),
      ).rejects.toThrow();

      const logged = warn.mock.calls.flat().join(" ");
      expect(logged).not.toContain(SECRET);
      expect(logged).not.toContain("wrong-secret");
      warn.mockRestore();
    });

    it("answers 404 on the signature route for an apiKey channel", async () => {
      await expect(
        controller.handleWhatsAppWebhook("test-instance", "sig", validBody, mockReq()),
      ).rejects.toThrow(/not configured/);
    });
  });

  it("answers 404 on the secret route for an authToken channel", async () => {
    // Default beforeEach config is an authToken channel.
    await expect(
      controller.handleWhatsAppWebhookWithSecret("test-instance", "any-secret", validBody),
    ).rejects.toThrow(/not configured/);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test -w @polyant/engine -- src/server/channels/twilio-webhook.controller.test.ts
```

Expected: FAIL — `controller.handleWhatsAppWebhookWithSecret is not a function`.

- [ ] **Step 3: Implement the route**

In `twilio-webhook.controller.ts`, extend the imports:

```ts
import { createHash, timingSafeEqual } from "node:crypto";
import { getChannelConfig, resolveWhatsAppAuthMode } from "../../instances/channels.store.js";
```

Add above the `@Controller` decorator:

```ts
/**
 * Constant-time comparison of two secrets. `timingSafeEqual` throws on a
 * length mismatch and the length itself would leak, so both sides are hashed
 * to a fixed 32 bytes first.
 */
function secretsMatch(expected: string, received: string): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(received).digest();
  return timingSafeEqual(a, b);
}
```

Refactor the existing handler body into two private helpers and add the second route. The class becomes:

```ts
@Controller("webhooks/twilio")
export class TwilioWebhookController {
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Public()
  @Post(":instanceSlug/whatsapp")
  @HttpCode(200)
  async handleWhatsAppWebhook(
    @Param("instanceSlug") instanceSlug: string,
    @Headers("x-twilio-signature") signature: string,
    @Body() body: TwilioWebhookBody,
    @Req() req: Request,
  ): Promise<string> {
    const { config, adapter } = await this.resolveActiveChannel(instanceSlug);

    // A channel authenticated by path secret must not be reachable here: a
    // 404 (not 403) keeps the credential mode of a slug from leaking to an
    // unauthenticated caller.
    if (resolveWhatsAppAuthMode(config) !== "authToken") {
      throw new NotFoundException(`WhatsApp channel not configured for "${instanceSlug}"`);
    }

    // Use the full URL from the request so it matches what Twilio signed against
    // (critical when behind proxies like ngrok)
    const webhookUrl = this.getFullUrl(req);
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === "string") params[key] = value;
    }

    const isValid = adapter.validateSignature(signature || "", webhookUrl, params);
    if (!isValid) {
      console.warn(`[whatsapp] Invalid Twilio signature for instance "${instanceSlug}" (url: ${webhookUrl})`);
      throw new ForbiddenException("Invalid Twilio signature");
    }

    return this.dispatchInbound(instanceSlug, adapter, body);
  }

  /**
   * Inbound for channels holding a Twilio API Key instead of the account Auth
   * Token. Twilio signs webhooks with the Auth Token only, so authenticity is
   * established by a server-generated secret in the path.
   *
   * Accepted cost: the secret appears in reverse-proxy access logs. Twilio
   * messaging webhooks cannot carry custom headers, so a path segment is the
   * only channel available; rotation is the mitigation.
   */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Public()
  @Post(":instanceSlug/whatsapp/:webhookSecret")
  @HttpCode(200)
  async handleWhatsAppWebhookWithSecret(
    @Param("instanceSlug") instanceSlug: string,
    @Param("webhookSecret") webhookSecret: string,
    @Body() body: TwilioWebhookBody,
  ): Promise<string> {
    const { config, adapter } = await this.resolveActiveChannel(instanceSlug);

    if (resolveWhatsAppAuthMode(config) !== "apiKey") {
      throw new NotFoundException(`WhatsApp channel not configured for "${instanceSlug}"`);
    }

    const expected = typeof config.webhookSecret === "string" ? config.webhookSecret : "";
    if (!expected || !secretsMatch(expected, webhookSecret)) {
      // Slug only — never the secret, never the path.
      console.warn("[whatsapp] Invalid webhook secret for instance:", instanceSlug);
      throw new ForbiddenException("Invalid webhook credentials");
    }

    return this.dispatchInbound(instanceSlug, adapter, body);
  }

  /** Resolve the instance, its stored WhatsApp config and the running adapter. */
  private async resolveActiveChannel(
    instanceSlug: string,
  ): Promise<{ config: Record<string, unknown>; adapter: WhatsAppAdapter }> {
    const instanceId = await resolveInstanceId(asInstanceSlug(instanceSlug));
    if (!instanceId) throw new NotFoundException(`Instance "${instanceSlug}" not found`);

    const channelConfig = await getChannelConfig(asInstanceSlug(instanceSlug), "whatsapp");
    if (!channelConfig || !channelConfig.enabled) {
      throw new NotFoundException(`WhatsApp channel not configured for "${instanceSlug}"`);
    }

    const instanceMap = (channelManager as any).adapters.get(instanceSlug) as Map<string, WhatsAppAdapter> | undefined;
    const adapter = instanceMap?.get("whatsapp") as WhatsAppAdapter | undefined;
    if (!adapter) {
      throw new NotFoundException(`WhatsApp adapter not active for "${instanceSlug}"`);
    }

    return { config: channelConfig.config, adapter };
  }

  /** Hand the authenticated message to the pipeline and answer Twilio at once. */
  private dispatchInbound(instanceSlug: string, adapter: WhatsAppAdapter, body: TwilioWebhookBody): string {
    const from = body.From?.replace(/^whatsapp:/, "") || "";

    // Collect media URLs (Twilio sends MediaUrl0, MediaUrl1, ...)
    const mediaItems: Array<{ url: string; contentType: string }> = [];
    const numMedia = parseInt(body.NumMedia ?? "0", 10);
    for (let i = 0; i < numMedia; i++) {
      const url = (body as unknown as Record<string, string>)[`MediaUrl${i}`];
      const contentType = (body as unknown as Record<string, string>)[`MediaContentType${i}`] ?? "application/octet-stream";
      if (url) mediaItems.push({ url, contentType });
    }

    // Fire-and-forget so Twilio is not kept waiting for the pipeline.
    adapter.handleInbound({
      from,
      body: body.Body || "",
      profileName: body.ProfileName,
      messageSid: body.MessageSid,
      instanceId: asInstanceSlug(instanceSlug),
      media: mediaItems.length > 0 ? mediaItems : undefined,
    }).catch((err) =>
      // Pass the user-controlled slug as a separate argument so it is never
      // treated as part of the format string (CodeQL js/tainted-format-string).
      console.error("[whatsapp] Error processing inbound for instance:", instanceSlug, err),
    );

    return "<Response/>";
  }

  /** Reconstruct the full URL as seen by the external caller (Twilio).
   *  Honors X-Forwarded-Proto / X-Forwarded-Host set by reverse proxies (ngrok, Render, etc). */
  private getFullUrl(req: Request): string {
    const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
    const host = (req.headers["x-forwarded-host"] as string) || req.get("host") || "localhost";
    return `${proto}://${host}${req.originalUrl}`;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm run test -w @polyant/engine -- src/server/channels/twilio-webhook.controller.test.ts
```

Expected: PASS — the 6 new tests plus every pre-existing one (signature path unchanged).

- [ ] **Step 5: Verify the route-authorization guardrail still holds**

```bash
npm run test -w @polyant/engine -- src/server/route-authorization-guardrail.test.ts
```

Expected: PASS. The new route is `@Public()` and declares no permission, which is what the guardrail requires.

- [ ] **Step 6: Commit**

```bash
cat > /tmp/msg.txt <<'EOF'
feat(whatsapp): authenticate inbound without an auth token

Twilio computes X-Twilio-Signature as HMAC-SHA1 keyed with the account
Auth Token and offers no API-Key-keyed variant, so a channel holding
only an API Key had no way to prove an inbound request came from Twilio.

Adds a second webhook route carrying a server-generated secret in the
path, compared in constant time over SHA-256 digests so neither the
value nor its length leaks. The signature route is unchanged for
authToken channels; each route answers 404 for a channel in the other
mode, so an unauthenticated caller cannot discover which mode a slug
uses. The rejection log carries the slug only.

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
EOF
git add packages/engine/src/server/channels/
git commit -F /tmp/msg.txt
```

---

### Task 6: Management API — allowlist merge, secret minting, reveal and rotate

**Files:**
- Create: `packages/engine/src/server/webhook-url.ts`
- Modify: `packages/engine/src/server/webhooks/webhook-sources.controller.ts:18-21`
- Modify: `packages/engine/src/server/instances/instance-channels.controller.ts`
- Test: `packages/engine/src/server/instances/instance-channels.controller.test.ts` (create)

**Interfaces:**
- Consumes: `CHANNEL_CONFIG_KEYS`, `pruneWhatsAppCredentials`, `resolveWhatsAppAuthMode` (Task 2); `generateToken` from `crypto/index.js`.
- Produces:
  - `engineBaseUrl(): string`
  - `buildEventSourceWebhookUrl(token: string): string`
  - `buildTwilioWhatsAppWebhookUrl(slug: string, webhookSecret: string): string`
  - `GET /api/instances/:slug/channels/whatsapp/webhook-url` → `{ webhookUrl: string }`
  - `POST /api/instances/:slug/channels/whatsapp/rotate-webhook-secret` → `{ webhookUrl: string }`

- [ ] **Step 1: Write the failing test**

Create `packages/engine/src/server/instances/instance-channels.controller.test.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockSetChannelConfig,
  mockGetChannelConfig,
  mockChannelManager,
  mockAuditLog,
} = vi.hoisted(() => ({
  mockSetChannelConfig: vi.fn(),
  mockGetChannelConfig: vi.fn(),
  mockChannelManager: { startChannel: vi.fn(), stopChannel: vi.fn() },
  mockAuditLog: vi.fn(),
}));

vi.mock("../../instances/channels.store.js", async () => {
  const actual = await vi.importActual<typeof import("../../instances/channels.store.js")>(
    "../../instances/channels.store.js",
  );
  return {
    ...actual,
    setChannelConfig: mockSetChannelConfig,
    getChannelConfig: mockGetChannelConfig,
    listChannelConfigs: vi.fn().mockResolvedValue([]),
    deleteChannelConfig: vi.fn(),
  };
});

vi.mock("../../channels/channel-manager.js", () => ({ channelManager: mockChannelManager }));
vi.mock("../../instances/agent-tool-sync.js", () => ({ syncAgentTool: vi.fn() }));
vi.mock("./instance-helpers.js", async () => {
  const actual = await vi.importActual<typeof import("./instance-helpers.js")>("./instance-helpers.js");
  return { ...actual, findInstanceOrFail: vi.fn().mockResolvedValue({ id: "uuid-1", slug: "acme", description: null }) };
});
vi.mock("../../management-audit/management-audit-logger.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../management-audit/management-audit-logger.js")
  >("../../management-audit/management-audit-logger.js");
  return { ...actual, createManagementAuditLogger: () => ({ log: mockAuditLog }) };
});

import { InstanceChannelsController } from "./instance-channels.controller.js";

const ACCOUNT_SID = "AC00000000000000000000000000000001";
const API_KEY_SID = "SK00000000000000000000000000000002";
const USER = { id: "u1", email: "admin@example.com" } as never;

describe("InstanceChannelsController — whatsapp credential modes", () => {
  let controller: InstanceChannelsController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new InstanceChannelsController();
    mockGetChannelConfig.mockResolvedValue(null);
  });

  it("should_mint_a_webhook_secret_on_the_first_save_in_apiKey_mode", async () => {
    await controller.setChannel("acme", "whatsapp", {
      config: {
        authMode: "apiKey",
        accountSid: ACCOUNT_SID,
        apiKeySid: API_KEY_SID,
        apiKeySecret: "sec",
        whatsappNumber: "+14155238886",
      },
      enabled: true,
    });

    const stored = mockSetChannelConfig.mock.calls[0][2] as Record<string, unknown>;
    expect(stored.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("should_ignore_a_client_supplied_webhook_secret", async () => {
    await controller.setChannel("acme", "whatsapp", {
      config: {
        authMode: "apiKey",
        accountSid: ACCOUNT_SID,
        apiKeySid: API_KEY_SID,
        apiKeySecret: "sec",
        whatsappNumber: "+14155238886",
        webhookSecret: "attacker-chosen",
      },
      enabled: true,
    });

    const stored = mockSetChannelConfig.mock.calls[0][2] as Record<string, unknown>;
    expect(stored.webhookSecret).not.toBe("attacker-chosen");
  });

  it("should_drop_the_auth_token_when_switching_to_apiKey", async () => {
    mockGetChannelConfig.mockResolvedValue({
      channelType: "whatsapp",
      enabled: true,
      config: { authMode: "authToken", accountSid: ACCOUNT_SID, authToken: "old", whatsappNumber: "+14155238886" },
    });

    await controller.setChannel("acme", "whatsapp", {
      config: { authMode: "apiKey", apiKeySid: API_KEY_SID, apiKeySecret: "sec" },
      enabled: true,
    });

    const stored = mockSetChannelConfig.mock.calls[0][2] as Record<string, unknown>;
    expect(stored).not.toHaveProperty("authToken");
  });

  it("should_reveal_the_webhook_url_for_an_apiKey_channel", async () => {
    mockGetChannelConfig.mockResolvedValue({
      channelType: "whatsapp",
      enabled: true,
      config: { authMode: "apiKey", webhookSecret: "abc123", accountSid: ACCOUNT_SID },
    });

    const res = await controller.whatsappWebhookUrl("acme");
    expect(res.webhookUrl).toContain("/webhooks/twilio/acme/whatsapp/abc123");
  });

  it("should_refuse_to_reveal_a_url_for_an_authToken_channel", async () => {
    mockGetChannelConfig.mockResolvedValue({
      channelType: "whatsapp",
      enabled: true,
      config: { authMode: "authToken", accountSid: ACCOUNT_SID, authToken: "tok" },
    });

    await expect(controller.whatsappWebhookUrl("acme")).rejects.toThrow();
  });

  it("should_rotate_the_secret_and_audit_the_write", async () => {
    mockGetChannelConfig.mockResolvedValue({
      channelType: "whatsapp",
      enabled: true,
      config: {
        authMode: "apiKey",
        accountSid: ACCOUNT_SID,
        apiKeySid: API_KEY_SID,
        apiKeySecret: "sec",
        webhookSecret: "old-secret",
        whatsappNumber: "+14155238886",
      },
    });

    const res = await controller.rotateWhatsappWebhookSecret("acme", USER);

    const stored = mockSetChannelConfig.mock.calls[0][2] as Record<string, unknown>;
    expect(stored.webhookSecret).not.toBe("old-secret");
    expect(res.webhookUrl).not.toContain("old-secret");
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "secret.write", targetType: "secret" }),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test -w @polyant/engine -- src/server/instances/instance-channels.controller.test.ts
```

Expected: FAIL — `controller.whatsappWebhookUrl is not a function`.

- [ ] **Step 3: Create the shared URL helper**

Create `packages/engine/src/server/webhook-url.ts`:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import { config } from "../config.js";

/**
 * The engine's public base URL — how an external producer (Twilio, a webhook
 * caller) must address it. Falls back to localhost so a local dev setup shows
 * a usable URL instead of an empty prefix.
 */
export function engineBaseUrl(): string {
  return config.server.baseUrl ?? `http://localhost:${config.server.port}`;
}

/** Ingestion URL of a Room event source. */
export function buildEventSourceWebhookUrl(token: string): string {
  return `${engineBaseUrl()}/webhooks/${token}`;
}

/**
 * Inbound URL to paste into the Twilio Console for a WhatsApp channel in
 * `apiKey` mode. The secret is the authentication gate — Twilio signs webhooks
 * with the account Auth Token, which this mode does not have.
 */
export function buildTwilioWhatsAppWebhookUrl(slug: string, webhookSecret: string): string {
  return `${engineBaseUrl()}/webhooks/twilio/${encodeURIComponent(slug)}/whatsapp/${encodeURIComponent(webhookSecret)}`;
}
```

Then in `packages/engine/src/server/webhooks/webhook-sources.controller.ts` delete the private `buildWebhookUrl` (lines 18-21) and import the shared one, aliased so the three call sites need no edit:

```ts
import { buildEventSourceWebhookUrl as buildWebhookUrl } from "../webhook-url.js";
```

Remove the now-unused `config` import from that file if lint flags it.

- [ ] **Step 4: Implement the controller changes**

In `packages/engine/src/server/instances/instance-channels.controller.ts`, extend the imports:

```ts
import { Get, Post, NotFoundException } from "@nestjs/common"; // merge into the existing @nestjs/common import
import {
  setChannelConfig, listChannelConfigs, getChannelConfig, deleteChannelConfig,
  CHANNEL_TYPES, CHANNEL_CONFIG_KEYS, pruneWhatsAppCredentials, resolveWhatsAppAuthMode,
  type ChannelType,
} from "../../instances/channels.store.js";
import { generateToken } from "../../crypto/index.js";
import { buildTwilioWhatsAppWebhookUrl } from "../webhook-url.js";
import { CurrentUser } from "../../auth/decorators/current-user.decorator.js";
import type { AuthenticatedUser } from "../../auth/auth.types.js";
import {
  createManagementAuditLogger,
  ManagementAuditAction,
  ManagementAuditTarget,
  toManagementAuditActor,
} from "../../management-audit/management-audit-logger.js";
```

Add the audit logger as a class field, directly under `export class InstanceChannelsController {`:

```ts
  private readonly auditLogger = createManagementAuditLogger();
```

Replace the merge loop in `setChannel` (lines 49-55) with:

```ts
    // Merge with existing config, walking the ALLOWLIST rather than the request
    // body: no property name written into a stored config may come from remote
    // input. Masked values (••••) are skipped so unchanged secrets survive.
    const existing = await getChannelConfig(asInstanceSlug(slug), channelType as ChannelType);
    const mergedConfig: Record<string, unknown> = { ...(existing?.config ?? {}) };
    for (const key of CHANNEL_CONFIG_KEYS[channelType as ChannelType]) {
      if (!(key in body.config)) continue;
      const value = body.config[key];
      if (typeof value === "string" && value.startsWith("••••")) continue;
      mergedConfig[key] = value;
    }

    const finalConfig =
      channelType === "whatsapp" ? this.prepareWhatsAppConfig(mergedConfig) : mergedConfig;
```

and pass `finalConfig` to `setChannelConfig` and to both `channelManager.startChannel` calls in that method (replacing every remaining `mergedConfig` reference).

Add these three members at the end of the class:

```ts
  /**
   * Prune the unused mode's credentials and mint the inbound secret. The
   * `apiKey` schema variant REQUIRES `webhookSecret` and no client may send one
   * (it is absent from CHANNEL_CONFIG_KEYS), so the server mints it here —
   * before validation, or every first save in that mode would fail its own
   * schema.
   */
  private prepareWhatsAppConfig(merged: Record<string, unknown>): Record<string, unknown> {
    const pruned = pruneWhatsAppCredentials(merged);
    if (resolveWhatsAppAuthMode(pruned) === "apiKey" && !pruned.webhookSecret) {
      return { ...pruned, webhookSecret: generateToken(32) };
    }
    return pruned;
  }

  /**
   * The inbound URL to paste into the Twilio Console. Gated on CHANNEL_WRITE,
   * not CHANNEL_READ: the secret it embeds is bearer-equivalent, so a
   * read-only role must not be able to take over an agent's inbound channel.
   */
  @RequirePermission(Permission.CHANNEL_WRITE)
  @Get(":slug/channels/whatsapp/webhook-url")
  async whatsappWebhookUrl(@Param("slug") slug: string) {
    await findInstanceOrFail(slug);
    const channel = await getChannelConfig(asInstanceSlug(slug), "whatsapp");
    const secret = channel && resolveWhatsAppAuthMode(channel.config) === "apiKey"
      ? channel.config.webhookSecret
      : undefined;
    if (typeof secret !== "string" || !secret) {
      throw new NotFoundException("WhatsApp channel is not configured in API Key mode");
    }
    return { webhookUrl: buildTwilioWhatsAppWebhookUrl(slug, secret) };
  }

  /** Rotate the inbound secret. The previous URL stops working immediately. */
  @RequirePermission(Permission.CHANNEL_WRITE)
  @Post(":slug/channels/whatsapp/rotate-webhook-secret")
  async rotateWhatsappWebhookSecret(
    @Param("slug") slug: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const instance = await findInstanceOrFail(slug);
    const channel = await getChannelConfig(asInstanceSlug(slug), "whatsapp");
    if (!channel || resolveWhatsAppAuthMode(channel.config) !== "apiKey") {
      throw new NotFoundException("WhatsApp channel is not configured in API Key mode");
    }

    const webhookSecret = generateToken(32);
    const config = { ...channel.config, webhookSecret };
    await setChannelConfig(instance.id, "whatsapp", config, channel.enabled);
    if (channel.enabled) {
      await channelManager.startChannel(slug, "whatsapp", config);
    }

    this.auditLogger.log({
      action: ManagementAuditAction.SecretWrite,
      actor: toManagementAuditActor(user),
      targetType: ManagementAuditTarget.Secret,
      // Key only — the value is never audited.
      targetId: `${slug}:whatsapp.webhookSecret`,
    });

    return { webhookUrl: buildTwilioWhatsAppWebhookUrl(slug, webhookSecret) };
  }
```

Declare the two new routes ABOVE the generic `@Put(":slug/channels/:type")` / `@Delete(":slug/channels/:type")` handlers if NestJS resolves `whatsapp/webhook-url` as a `:type` — they are different depths and methods, so ordering is defensive rather than required.

- [ ] **Step 5: Run the test to verify it passes**

```bash
npm run test -w @polyant/engine -- src/server/instances/instance-channels.controller.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Run the full engine suite and compare against the baseline**

```bash
npm run test -w @polyant/engine 2>&1 | tail -20
npm run typecheck -w @polyant/engine
npm run lint -w @polyant/engine
```

Expected: no failures beyond those recorded in `/tmp/whatsapp-apikey-baseline.txt`; typecheck and lint clean.

- [ ] **Step 7: Commit**

```bash
cat > /tmp/msg.txt <<'EOF'
feat(whatsapp): mint, reveal and rotate the inbound webhook secret

The channels PUT handler now walks CHANNEL_CONFIG_KEYS instead of the
request body, prunes the credentials of the mode not in use, and mints
the webhookSecret server-side on the first save in apiKey mode. A
client-supplied webhookSecret is ignored: the key is absent from the
allowlist.

Adds GET webhook-url and POST rotate-webhook-secret, both behind
CHANNEL_WRITE because the secret they carry is bearer-equivalent, with
the rotation recorded in the management audit log (key only, never the
value). buildWebhookUrl moves out of the event-sources controller into
a shared helper so both webhook kinds compose URLs one way.

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
EOF
git add packages/engine/src/server/
git commit -F /tmp/msg.txt
```

---

### Task 7: Guard the export naming trap

`export.service.ts` strips every config key matching `/(?:token|secret|password|key|credential)/i` from an instance bundle. The discriminant is named `authMode` precisely so it survives. This test pins that, and would have caught the original `credentialMode` naming.

**Files:**
- Test: `packages/engine/src/instances/export.schema.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe("stripSensitiveKeys", …)`:

```ts
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
```

- [ ] **Step 2: Run the test**

```bash
npm run test -w @polyant/engine -- src/instances/export.schema.test.ts
```

Expected: PASS immediately — this is a regression pin, not a red test. If it FAILS, the discriminant was renamed to something the pattern matches; fix the name, not the test.

- [ ] **Step 3: Commit**

```bash
cat > /tmp/msg.txt <<'EOF'
test(export): pin that the whatsapp authMode survives a bundle export

Instance export strips config keys matching token/secret/password/key/
credential. The credential-mode discriminant is deliberately named
authMode so it is not stripped: a bundle that loses it reimports as an
authToken channel with no error anywhere.

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
EOF
git add packages/engine/src/instances/export.schema.test.ts
git commit -F /tmp/msg.txt
```

---

### Task 8: Admin panel — API client, i18n, WhatsApp card

**Files:**
- Modify: `packages/web/src/lib/api.ts:359-372`
- Modify: `packages/web/src/lib/i18n/locales/it.json`, `packages/web/src/lib/i18n/locales/en.json`
- Create: `packages/web/src/app/(admin)/instances/[slug]/whatsapp-channel-card.tsx`
- Test: `packages/web/src/app/(admin)/instances/[slug]/whatsapp-channel-card.test.tsx`

**Interfaces:**
- Consumes: `GET/POST` endpoints from Task 6.
- Produces: `<WhatsAppChannelCard slug channel onChanged />`, plus `api.channels.webhookUrl(slug)` and `api.channels.rotateWebhookSecret(slug)`.

- [ ] **Step 1: Extend the API client**

In `packages/web/src/lib/api.ts`, inside the `channels` object (after `delete`):

```ts
    webhookUrl: (slug: string) =>
      request<{ webhookUrl: string }>(
        `/api/instances/${encodeURIComponent(slug)}/channels/whatsapp/webhook-url`,
      ),
    rotateWebhookSecret: (slug: string) =>
      request<{ webhookUrl: string }>(
        `/api/instances/${encodeURIComponent(slug)}/channels/whatsapp/rotate-webhook-secret`,
        { method: "POST" },
      ),
```

- [ ] **Step 2: Add the i18n keys**

In `packages/web/src/lib/i18n/locales/it.json`, after `"channels.tab.whatsappNumber"`:

```json
  "channels.tab.whatsappAuthMode": "Modalità credenziali",
  "channels.tab.whatsappAuthModeToken": "Auth Token",
  "channels.tab.whatsappAuthModeApiKey": "API Key",
  "channels.tab.whatsappAuthModeHelp": "L'Auth Token consente la verifica della firma dei webhook. Con l'API Key i messaggi entranti vengono autenticati da un segreto nell'URL.",
  "channels.tab.whatsappApiKeySid": "Twilio API Key SID",
  "channels.tab.whatsappApiKeySecret": "Twilio API Key Secret",
  "channels.tab.whatsappModeSwitchWarning": "Al salvataggio le credenziali dell'altra modalità vengono eliminate.",
  "channels.tab.whatsappWebhookUrl": "URL webhook da configurare in Twilio",
  "channels.tab.whatsappWebhookUrlHelp": "Incolla questo URL nella Twilio Console. Fino a quel momento i messaggi entranti non vengono consegnati.",
  "channels.tab.whatsappRotateSecret": "Rigenera",
  "channels.tab.whatsappRotateTitle": "Rigenerare il segreto del webhook?",
  "channels.tab.whatsappRotateDescription": "L'URL attuale smette di funzionare immediatamente. I messaggi entranti si perdono finché il nuovo URL non è configurato in Twilio.",
  "channels.tab.whatsappUrlCopied": "URL copiato",
```

In `packages/web/src/lib/i18n/locales/en.json`, the same keys:

```json
  "channels.tab.whatsappAuthMode": "Credential mode",
  "channels.tab.whatsappAuthModeToken": "Auth Token",
  "channels.tab.whatsappAuthModeApiKey": "API Key",
  "channels.tab.whatsappAuthModeHelp": "An Auth Token enables webhook signature validation. With an API Key, inbound messages are authenticated by a secret in the URL.",
  "channels.tab.whatsappApiKeySid": "Twilio API Key SID",
  "channels.tab.whatsappApiKeySecret": "Twilio API Key Secret",
  "channels.tab.whatsappModeSwitchWarning": "Saving discards the other mode's credentials.",
  "channels.tab.whatsappWebhookUrl": "Webhook URL to configure in Twilio",
  "channels.tab.whatsappWebhookUrlHelp": "Paste this URL into the Twilio Console. Until you do, inbound messages are not delivered.",
  "channels.tab.whatsappRotateSecret": "Regenerate",
  "channels.tab.whatsappRotateTitle": "Regenerate the webhook secret?",
  "channels.tab.whatsappRotateDescription": "The current URL stops working immediately. Inbound messages are lost until the new URL is configured in Twilio.",
  "channels.tab.whatsappUrlCopied": "URL copied",
```

- [ ] **Step 3: Write the failing test**

Create `packages/web/src/app/(admin)/instances/[slug]/whatsapp-channel-card.test.tsx`:

```tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockWebhookUrl, mockRotate, mockSet } = vi.hoisted(() => ({
  mockWebhookUrl: vi.fn(),
  mockRotate: vi.fn(),
  mockSet: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: { channels: { webhookUrl: mockWebhookUrl, rotateWebhookSecret: mockRotate, set: mockSet, delete: vi.fn() } },
  getUserErrorMessage: (_e: unknown, fallback: string) => fallback,
}));

vi.mock("@/lib/i18n/context", () => ({ useI18n: () => ({ t: (k: string) => k }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { WhatsAppChannelCard } from "./whatsapp-channel-card.js";

describe("WhatsAppChannelCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWebhookUrl.mockResolvedValue({ webhookUrl: "https://engine.example/webhooks/twilio/acme/whatsapp/abc" });
    mockSet.mockResolvedValue({ channel: null });
    mockRotate.mockResolvedValue({ webhookUrl: "https://engine.example/webhooks/twilio/acme/whatsapp/new" });
  });

  it("should_show_the_auth_token_field_in_authToken_mode", () => {
    render(<WhatsAppChannelCard slug="acme" channel={null} onChanged={vi.fn()} />);

    expect(screen.getByLabelText("channels.tab.whatsappAuthToken")).toBeDefined();
    expect(screen.queryByLabelText("channels.tab.whatsappApiKeySid")).toBeNull();
  });

  it("should_swap_to_the_api_key_fields_when_the_mode_changes", async () => {
    render(<WhatsAppChannelCard slug="acme" channel={null} onChanged={vi.fn()} />);

    await userEvent.selectOptions(
      screen.getByLabelText("channels.tab.whatsappAuthMode"),
      "apiKey",
    );

    expect(screen.getByLabelText("channels.tab.whatsappApiKeySid")).toBeDefined();
    expect(screen.queryByLabelText("channels.tab.whatsappAuthToken")).toBeNull();
    expect(screen.getByText("channels.tab.whatsappModeSwitchWarning")).toBeDefined();
  });

  it("should_show_the_webhook_url_for_a_saved_api_key_channel", async () => {
    render(
      <WhatsAppChannelCard
        slug="acme"
        channel={{ channelType: "whatsapp", enabled: true, config: { authMode: "apiKey" } }}
        onChanged={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("https://engine.example/webhooks/twilio/acme/whatsapp/abc")).toBeDefined(),
    );
  });

  it("should_not_fetch_a_webhook_url_for_an_auth_token_channel", () => {
    render(
      <WhatsAppChannelCard
        slug="acme"
        channel={{ channelType: "whatsapp", enabled: true, config: { authMode: "authToken" } }}
        onChanged={vi.fn()}
      />,
    );

    expect(mockWebhookUrl).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

```bash
npm run test -w @polyant/web -- src/app/\(admin\)/instances/\[slug\]/whatsapp-channel-card.test.tsx
```

Expected: FAIL — the module does not exist. If instead it fails to *collect* with a `radix-ui` resolution error, that is the known local-environment gap from Task 1: finish the implementation, then verify in CI and report it as CI-verified rather than locally passing.

- [ ] **Step 5: Implement the card**

Create `packages/web/src/app/(admin)/instances/[slug]/whatsapp-channel-card.tsx`:

```tsx
// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Copy, Eye, EyeOff, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { api, getUserErrorMessage, type ChannelConfig } from "@/lib/api";
import { useI18n } from "@/lib/i18n/context";

type AuthMode = "authToken" | "apiKey";

interface Props {
  slug: string;
  channel: ChannelConfig | null;
  onChanged: () => void;
}

/** Field sets per credential mode. `accountSid` and `whatsappNumber` are common. */
const MODE_FIELDS: Record<AuthMode, { key: string; labelKey: string; sensitive: boolean }[]> = {
  authToken: [{ key: "authToken", labelKey: "channels.tab.whatsappAuthToken", sensitive: true }],
  apiKey: [
    { key: "apiKeySid", labelKey: "channels.tab.whatsappApiKeySid", sensitive: true },
    { key: "apiKeySecret", labelKey: "channels.tab.whatsappApiKeySecret", sensitive: true },
  ],
};

/**
 * WhatsApp is the only channel with two mutually exclusive credential shapes
 * plus a webhook URL to hand back to the operator, so it gets a dedicated card
 * instead of bending the generic field-list renderer in channels-tab.
 */
export function WhatsAppChannelCard({ slug, channel, onChanged }: Props) {
  const { t } = useI18n();
  const storedMode: AuthMode = channel?.config?.authMode === "apiKey" ? "apiKey" : "authToken";

  const [mode, setMode] = useState<AuthMode>(storedMode);
  const [enabled, setEnabled] = useState(channel?.enabled ?? false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const loadWebhookUrl = useCallback(async () => {
    // Only an apiKey channel has a secret-bearing URL, and only after its
    // first save (the secret is minted server-side at that point).
    if (storedMode !== "apiKey" || !channel) {
      setWebhookUrl(null);
      return;
    }
    try {
      const res = await api.channels.webhookUrl(slug);
      setWebhookUrl(res.webhookUrl);
    } catch {
      setWebhookUrl(null);
    }
  }, [slug, storedMode, channel]);

  useEffect(() => {
    void loadWebhookUrl();
  }, [loadWebhookUrl]);

  function updateValue(key: string, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }

  function changeMode(next: AuthMode) {
    setMode(next);
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      // Send only fields the operator actually filled in; the server merges
      // with the stored config and drops masked placeholders.
      const config: Record<string, string> = { authMode: mode };
      for (const [k, v] of Object.entries(values)) {
        if (v !== "") config[k] = v;
      }
      await api.channels.set(slug, "whatsapp", config, enabled);
      toast.success(t("channels.tab.saved"));
      setValues({});
      setDirty(false);
      onChanged();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("channels.tab.saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  async function rotate() {
    try {
      const res = await api.channels.rotateWebhookSecret(slug);
      setWebhookUrl(res.webhookUrl);
      toast.success(t("channels.tab.saved"));
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("channels.tab.saveFailed")));
    }
  }

  async function remove() {
    try {
      await api.channels.delete(slug, "whatsapp");
      toast.success(t("channels.tab.removed"));
      onChanged();
    } catch (err) {
      toast.error(getUserErrorMessage(err, t("channels.tab.removeFailed")));
    }
  }

  const fields = [
    { key: "accountSid", labelKey: "channels.tab.whatsappAccountSid", sensitive: true },
    ...MODE_FIELDS[mode],
    { key: "whatsappNumber", labelKey: "channels.tab.whatsappNumber", sensitive: false },
  ];

  return (
    <section className="space-y-4 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Label className="text-base font-medium">{t("channels.tab.whatsapp")}</Label>
            {channel && (
              <Badge variant={channel.enabled ? "default" : "secondary"} className="text-xs">
                {channel.enabled ? t("channels.tab.enabled") : t("channels.tab.disabled")}
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">{t("channels.tab.whatsappHelp")}</p>
        </div>
        <div className="flex items-center gap-2">
          {channel && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="icon" className="text-destructive">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("channels.tab.removeTitle")}</AlertDialogTitle>
                  <AlertDialogDescription>{t("channels.tab.removeDescription")}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={remove}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {t("common.delete")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => {
              setEnabled(checked);
              setDirty(true);
            }}
            disabled={saving}
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor="whatsapp-auth-mode">{t("channels.tab.whatsappAuthMode")}</Label>
        <p className="text-xs text-muted-foreground">{t("channels.tab.whatsappAuthModeHelp")}</p>
        {/* Native select: the mode drives which fields exist, and a plain
            element keeps this card testable without a portal-aware harness. */}
        <select
          id="whatsapp-auth-mode"
          className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
          value={mode}
          onChange={(e) => changeMode(e.target.value as AuthMode)}
        >
          <option value="authToken">{t("channels.tab.whatsappAuthModeToken")}</option>
          <option value="apiKey">{t("channels.tab.whatsappAuthModeApiKey")}</option>
        </select>
        {mode !== storedMode && (
          <p className="text-xs text-destructive">{t("channels.tab.whatsappModeSwitchWarning")}</p>
        )}
      </div>

      {fields.map((field) => {
        const stored = channel?.config?.[field.key];
        const placeholder = typeof stored === "string" ? stored : "";
        const isVisible = visible[field.key] ?? false;

        return (
          <div key={field.key} className="space-y-1">
            <Label htmlFor={`whatsapp-${field.key}`}>{t(field.labelKey)}</Label>
            <div className="relative">
              <Input
                id={`whatsapp-${field.key}`}
                type={field.sensitive && !isVisible ? "password" : "text"}
                value={values[field.key] ?? ""}
                onChange={(e) => updateValue(field.key, e.target.value)}
                placeholder={placeholder}
              />
              {field.sensitive && (
                <button
                  type="button"
                  onClick={() => setVisible((prev) => ({ ...prev, [field.key]: !prev[field.key] }))}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {isVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              )}
            </div>
          </div>
        );
      })}

      {webhookUrl && (
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">{t("channels.tab.whatsappWebhookUrl")}</Label>
          <p className="text-xs text-muted-foreground">{t("channels.tab.whatsappWebhookUrlHelp")}</p>
          <div className="flex items-center gap-2">
            <code className="block flex-1 break-all rounded bg-muted px-2 py-1 text-xs">{webhookUrl}</code>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => {
                void navigator.clipboard.writeText(webhookUrl);
                toast.success(t("channels.tab.whatsappUrlCopied"));
              }}
            >
              <Copy className="h-4 w-4" />
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="icon" variant="ghost">
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("channels.tab.whatsappRotateTitle")}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("channels.tab.whatsappRotateDescription")}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                  <AlertDialogAction onClick={rotate}>
                    {t("channels.tab.whatsappRotateSecret")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      )}

      {dirty && (
        <div className="flex justify-end">
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? t("common.saving") : t("common.saveSingle")}
          </Button>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
npm run test -w @polyant/web -- src/app/\(admin\)/instances/\[slug\]/whatsapp-channel-card.test.tsx
```

Expected: PASS, 4 tests — or the known `radix-ui` collection failure, in which case say so explicitly and defer to CI.

- [ ] **Step 7: Commit**

```bash
cat > /tmp/msg.txt <<'EOF'
feat(web): dedicated WhatsApp channel card with credential modes

The channels tab renders every channel through one generic field-list
loop, which cannot express two mutually exclusive credential shapes
plus a webhook URL to hand back to the operator. WhatsApp moves into
its own card, following the pattern of the room event-source card.

The card offers the credential-mode select, the fields for the selected
mode, a warning that switching discards the other mode's credentials,
and — for a saved API Key channel — the webhook URL with copy and
regenerate actions, the latter behind a confirmation that states the
current URL stops working immediately.

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
EOF
git add packages/web/src/lib/api.ts packages/web/src/lib/i18n/locales/ "packages/web/src/app/(admin)/instances/[slug]/whatsapp-channel-card.tsx" "packages/web/src/app/(admin)/instances/[slug]/whatsapp-channel-card.test.tsx"
git commit -F /tmp/msg.txt
```

---

### Task 9: Wire the card into the channels tab

**Files:**
- Modify: `packages/web/src/app/(admin)/instances/[slug]/channels-tab.tsx:58-67,205-215`

**Interfaces:**
- Consumes: `<WhatsAppChannelCard slug channel onChanged />` (Task 8).

- [ ] **Step 1: Import the card**

Add to the imports of `channels-tab.tsx`:

```tsx
import { WhatsAppChannelCard } from "./whatsapp-channel-card";
```

- [ ] **Step 2: Mark the whatsapp entry as custom-rendered**

Replace the `whatsapp` entry of `CHANNEL_DEFS` (lines 58-67) with:

```tsx
  {
    type: "whatsapp",
    nameKey: "channels.tab.whatsapp" as const,
    helpKey: "channels.tab.whatsappHelp" as const,
    // Rendered by WhatsAppChannelCard — two credential modes plus a webhook
    // URL do not fit the generic field-list renderer. Kept in this list so the
    // channel keeps its position in the page order.
    fields: [] as { key: string; labelKey: "channels.tab.whatsapp"; sensitive: boolean }[],
    custom: true,
  },
```

- [ ] **Step 3: Early-return the card inside the render loop**

Immediately after `const isNoConfig = "noConfig" in def && def.noConfig;` (line ~212), insert:

```tsx
        if ("custom" in def && def.custom) {
          return (
            <WhatsAppChannelCard
              key={def.type}
              slug={slug}
              channel={existingChannel ?? null}
              onChanged={() => {
                void api.channels.list(slug).then((res) => {
                  setChannels(res.channels);
                  initStates(res.channels);
                });
              }}
            />
          );
        }
```

- [ ] **Step 4: Typecheck and lint the web package**

```bash
npm run typecheck -w @polyant/web
npm run lint -w @polyant/web
```

Expected: no errors. The `"custom" in def && def.custom` narrowing mirrors the `"noConfig" in def && def.noConfig` check already in this file, which typechecks against the same heterogeneous array literal.

- [ ] **Step 5: Run the web suite and compare against the baseline**

```bash
npm run test -w @polyant/web 2>&1 | tail -20
```

Expected: no failures beyond the Task 1 baseline.

- [ ] **Step 6: Commit**

```bash
cat > /tmp/msg.txt <<'EOF'
feat(web): render the WhatsApp channel through its dedicated card

The channels tab keeps its generic loop for telegram, slack and agent,
and early-returns the WhatsApp card so the channel keeps its position
in the page while owning its own form.

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
EOF
git add "packages/web/src/app/(admin)/instances/[slug]/channels-tab.tsx"
git commit -F /tmp/msg.txt
```

---

### Task 10: Documentation and full verification

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md:227`
- Modify: `.env.example:87-93`

- [ ] **Step 1: Document the two modes in CLAUDE.md**

Add this bullet to the "Important Caveats" list:

```markdown
- **The WhatsApp channel authenticates to Twilio in one of two modes** (`authMode` in the channel config, defaulting to `authToken` for configs written before the feature). `authToken` = the account Auth Token: unchanged behaviour, inbound webhooks validated via `X-Twilio-Signature` on `POST /webhooks/twilio/:slug/whatsapp`. `apiKey` = a revocable API Key (`apiKeySid` + `apiKeySecret`), passed to the Twilio SDK as `Twilio(apiKeySid, apiKeySecret, { accountSid })` because the SDK builds `/Accounts/{AC…}` REST paths from the account SID. Twilio keys webhook signatures on the Auth Token ONLY and publishes no API-Key-keyed variant, so an `apiKey` channel authenticates inbound on a SECOND route, `POST /webhooks/twilio/:slug/whatsapp/:webhookSecret`, where `webhookSecret` is server-minted (`generateToken(32)`), absent from `CHANNEL_CONFIG_KEYS` so no client can impose it, and compared in constant time over SHA-256 digests. Each route answers **404** (not 403) for a channel in the other mode, so the credential mode of a slug does not leak. Reveal + rotation live at `GET/POST /api/instances/:slug/channels/whatsapp/webhook-url|rotate-webhook-secret` behind `CHANNEL_WRITE` (the secret is bearer-equivalent), and rotation is audited as `secret.write` (key only). Caveats: `TRUST_PROXY` matters only in `authToken` mode (it exists so the HMAC is computed against the externally-visible URL — in `apiKey` mode no forwarded header can influence the gate); the secret rides in the URL path and therefore lands in reverse-proxy access logs, with rotation as the mitigation; and switching an existing channel to `apiKey` interrupts inbound between saving and re-pasting the URL in the Twilio Console.
```

- [ ] **Step 2: Update the README channel table**

Replace line 227:

```markdown
| **WhatsApp** | Webhook via Twilio (Auth Token or API Key) | Text and media attachments |
```

- [ ] **Step 3: Scope the TRUST_PROXY comment in .env.example**

Append to the `TRUST_PROXY` comment block (after line 92):

```
# Only relevant for a WhatsApp channel in `authToken` mode, whose inbound
# authentication is the Twilio HMAC over the reconstructed URL. A channel in
# `apiKey` mode is gated by a secret in the webhook path, which no forwarded
# header can influence.
```

- [ ] **Step 4: Run the complete verification**

```bash
npm run typecheck
npm run lint
npm run test -w @polyant/engine 2>&1 | tail -20
npm run test -w @polyant/web 2>&1 | tail -20
```

Expected: typecheck and lint clean; test totals equal to the Task 1 baseline plus the new tests, with no new failures. Write down the actual numbers — do not claim success without them.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/msg.txt <<'EOF'
docs(whatsapp): document the two Twilio credential modes

Records the authMode contract, the second inbound route and its
trade-offs (secret in the path, 404 on mode mismatch, TRUST_PROXY
relevant only to the signature mode) in CLAUDE.md, plus the README
channel table and a scoping note on TRUST_PROXY in .env.example.

Signed-off-by: Paolo Valletta <paolo.valletta@exelab.com>
EOF
git add CLAUDE.md README.md .env.example
git commit -F /tmp/msg.txt
```

- [ ] **Step 6: Push and open the PR against main**

```bash
git push -u origin fix/whatsapp-api-key-auth
```

PR title: `fix(whatsapp): support Twilio API Key authentication`

PR body must state: the two modes; that existing channels are unaffected (no `authMode` ⇒ `authToken`); no migration and no new env var; the inbound gap when switching an existing channel to API Key mode; and that the back-merge into `develop` needs the web card re-applied by hand under `organizations/[orgSlug]/workspaces/[workspaceSlug]/instances/[slug]/`.
