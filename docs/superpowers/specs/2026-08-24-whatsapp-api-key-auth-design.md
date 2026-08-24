# WhatsApp channel: Twilio API Key authentication

**Date:** 2026-08-24
**Status:** approved, not implemented
**Base branch:** `main` (hotfix — `develop` carries unrelated features that ship later)
**Branch:** `fix/whatsapp-api-key-auth`

## Problem

The WhatsApp channel accepts exactly three config keys — `accountSid`, `authToken`,
`whatsappNumber` — and treats the Auth Token as mandatory. An operator who holds a
Twilio **API Key** (`SK…` + secret) instead of the account's Auth Token cannot use the
channel at all:

- `TwilioWhatsAppClient.create()` calls `Twilio(accountSid, authToken)`. The Node SDK
  rejects any SID that does not start with `AC` and states that an API Key must be
  passed as the username **with `accountSid` as a third option**. Putting `SK…` in the
  `accountSid` field throws at adapter start.
- The typing indicator, the Content API call and the media download build
  `Basic base64(accountSid:authToken)` by hand in three separate places.
- Inbound webhooks are authenticated by validating `X-Twilio-Signature`, which is
  HMAC-SHA1 **keyed with the account's Auth Token**. Twilio publishes no API-Key-keyed
  signature and no separate webhook signing secret, so signature validation is
  structurally unavailable in an API-Key-only deployment.

Goal: make the channel work with either credential, and make the inbound path
independent of the Auth Token — not merely tolerant of its absence.

## Non-goals

- Replacing signature validation where an Auth Token *is* available. That path stays
  byte-identical.
- Re-validating configs already stored in the database. Legacy rows keep working.
- Any schema migration. Channel config is a single encrypted blob.

## Design

### 1. Configuration model

`channelConfigSchemas.whatsapp` becomes a `z.discriminatedUnion("authMode", …)`:

```
authMode: "authToken" | "apiKey"     // discriminant
accountSid:     /^AC[0-9a-fA-F]{32}$/   // was z.string().min(1)
whatsappNumber: /^\+\d+$/               // unchanged

// authMode = "authToken"
authToken:     string

// authMode = "apiKey"
apiKeySid:     /^SK[0-9a-fA-F]{32}$/
apiKeySecret:  string
webhookSecret: string                   // server-generated, never client-supplied
```

All string fields are `.trim()`ed: these values are pasted from a console and a
trailing space is otherwise a silent 401 from Twilio.

**Why an explicit discriminant and not a `z.union` of two shapes.** The PUT handler
merges the request body into the *existing* stored config. With a bare union, a
leftover `authToken` from a previous configuration plus new API-Key fields would still
satisfy the first variant (Zod strips unknown keys), and the channel would silently
keep using the stale Auth Token. The discriminant makes the intent explicit and the
mismatch a validation error.

**Why the field is named `authMode`.** `export.service.ts` strips every config key
matching `/(?:token|secret|password|key|credential)/i` from an instance bundle. A field
named `credentialMode` matches on `credential`, so it would vanish from every export and
silently fall back to `authToken` on re-import. `authMode` does not match the pattern.
Side effect of the same pattern: `apiKeySid` matches on `key` and is therefore masked in
the management API and stripped from exports. Harmless — a SID is not confidential, and
`accountSid` is already marked sensitive in the admin panel.

**Mode switching prunes the other mode's keys** before validation, so a discarded
credential does not stay encrypted at rest forever.

**Backward compatibility.** Existing rows have no `authMode`, and neither do existing
Management API callers that PUT the three legacy keys. Both are handled without touching
the channel-agnostic read path: on the way in, a `z.preprocess` step defaults a config
with no discriminant to `authToken` before the union is applied; on the way out, the
WhatsApp consumers resolve it (`resolveWhatsAppAuthMode`) rather than
`getChannelConfig`, which serves every channel type and must stay free of
WhatsApp-specific normalization. Every current installation keeps its exact behaviour
with no migration and no operator action. Note that stored configs
are validated on write only: a legacy row whose `accountSid` violates the new regex
keeps working until the next save of that channel, which will then reject it. Such a
value would already fail against Twilio, so this is a latent-bug reveal, not a
regression.

### 2. Twilio client

`TwilioWhatsAppClient.create()` dispatches on `authMode`:

| | `authToken` | `apiKey` |
|---|---|---|
| SDK constructor | `Twilio(accountSid, authToken)` | `Twilio(apiKeySid, apiKeySecret, { accountSid })` |
| Basic auth | `accountSid:authToken` | `apiKeySid:apiKeySecret` |
| `validateWebhook` | available | not applicable |

The three hand-rolled Basic headers (typing indicator, Content API, media download)
collapse into one private `basicAuthHeader()`, so the mode is resolved in one place
rather than four. `media-fetch.ts` already receives the header as a string and is
unchanged — including its per-hop SSRF re-validation and the drop of the credential on
cross-host redirect.

Format validation stays at the config boundary (Zod). `create()` validates only what it
structurally needs: which mode, and non-empty credentials for it.

### 3. Inbound authentication

A second route is added next to the existing one, in the same controller, sharing one
private handler:

```
POST /webhooks/twilio/:slug/whatsapp                 → authMode "authToken": HMAC signature (unchanged)
POST /webhooks/twilio/:slug/whatsapp/:webhookSecret   → authMode "apiKey": shared-secret compare
```

- **The routes do not cross over.** A request on the secret-less route for a channel in
  `apiKey` mode (or vice versa) returns `404`, not `403`: a 403 would confirm to an
  outsider which mode a given slug uses. A secret *mismatch* returns `403`, identical to
  a signature failure.
- **Constant-time comparison over digests.** `timingSafeEqual` throws on length
  mismatch, and the length is itself an oracle, so both sides are SHA-256'd to a fixed
  32 bytes before comparison.
- The existing `@Throttle({ limit: 60, ttl: 60_000 })` covers the new route. Brute
  forcing 256 bits is not a real threat; the limit exists so a Twilio misconfiguration
  cannot spin a 403 loop.
- **The 403 log line carries the slug only** — never the path, never the secret. The
  engine runs no HTTP request logger, so the secret is not written anywhere on our side.
- **Accepted cost:** the secret rides in the URL path and will appear in reverse-proxy
  access logs. This is inherent to a mechanism Twilio can drive (Twilio messaging
  webhooks cannot carry custom headers). The mitigation is rotation, which is needed
  anyway when staff change.
- `TRUST_PROXY` exists solely so the HMAC is computed against the externally-visible
  URL. In `apiKey` mode the gate is a path segment that no forwarded header can
  influence, so `TRUST_PROXY` is irrelevant to authentication there. Documented, so
  nobody raises it "to make the webhook work" and weakens the other mode.

### 4. Management API

Two endpoints, both `@RequirePermission(Permission.CHANNEL_WRITE)`:

```
GET  /api/instances/:slug/channels/whatsapp/webhook-url            → { webhookUrl }
POST /api/instances/:slug/channels/whatsapp/rotate-webhook-secret  → { webhookUrl }
```

- The URL is composed by the existing `buildWebhookUrl` helper (`BASE_URL`, falling back
  to `http://localhost:<port>`), extracted from `webhook-sources.controller.ts` into a
  shared module so both callers use one implementation and one response shape.
- The secret is `generateToken(32)` from `crypto/index.ts` — the same primitive as the
  Room event-source webhook tokens. Generated server-side when a channel first enters
  `apiKey` mode. **Ordering matters:** the `apiKey` variant requires `webhookSecret`, and
  no client ever sends it, so the PUT handler injects a freshly generated secret into the
  merged config (when the mode is `apiKey` and no secret is stored yet) *before* handing
  it to `setChannelConfig` for validation. Otherwise every first save in API Key mode
  would fail its own schema.
- `GET webhook-url` answers `404` for a channel in `authToken` mode: there is no secret
  and no secret-bearing URL to reveal. `rotate-webhook-secret` likewise.
- Rotation invalidates the old URL immediately and is recorded in the management audit
  log as `secret.write` on target `secret` (existing constants, none added).
- **`webhookSecret` is deliberately absent from `CHANNEL_CONFIG_KEYS`**, so no client
  can impose a weak value of its own choosing.

**Deliberate divergence from an existing convention:** Room event sources expose their
full webhook URL, token in clear, under `ROOM_READ`. This spec puts the WhatsApp secret
behind `CHANNEL_WRITE` — a read-only role must not be able to hijack an agent's inbound
channel. The looser treatment of event-source tokens is a separate finding to address on
`develop`, out of scope here.

### 5. Backported hardening: `CHANNEL_CONFIG_KEYS`

On `main` the channels PUT handler iterates the *request body* and writes whatever keys
it finds into the stored config. With `webhookSecret` living in that config, a caller
holding `CHANNEL_WRITE` could impose a secret of its own choosing, defeating
server-side generation. `develop` already hardened this with a `CHANNEL_CONFIG_KEYS`
allowlist the handler walks instead of the body; this spec backports it (~15 lines plus
a sync test). Side benefit: that hunk of the eventual back-merge becomes a no-op instead
of a conflict.

### 6. Admin panel

`channels-tab.tsx` renders every channel through one generic loop over a flat field
list. A mode selector, conditional fields and a webhook-URL panel would turn it into a
tree of per-channel conditionals, so WhatsApp is extracted into
`whatsapp-channel-card.tsx` with a colocated test — the pattern already used by
`room-event-source-card.tsx`. Telegram, Slack and agent stay in the generic loop.

The card contains:

- A **mode select** (Auth Token | API Key); defaults to Auth Token for configs without
  `authMode`.
- **Conditional fields**: Account SID + Auth Token, or Account SID + API Key SID + API
  Key Secret. The WhatsApp number is common. Existing mask/reveal behaviour and the
  masked-value placeholder are preserved.
- A **warning on mode change**, before saving, that the other mode's credentials will be
  discarded. Validation stays server-side; errors surface through the existing toast.
- A **webhook URL panel**, only in API Key mode and only after the first save (the
  secret is born there): `<code>` block, copy button, and a regenerate button behind an
  `AlertDialog` that states the URL must be re-pasted into the Twilio Console —
  mirroring the event-source card.

Roughly ten new i18n keys in `it.json` and `en.json`.

## Testing

Engine (vitest; the `twilio` module is already mocked in the existing suite):

| Assertion | File |
|---|---|
| `apiKey` mode passes `{ accountSid }` as the SDK's third argument; Basic auth is `SK:secret` vs `AC:token` (asserted on the typing-indicator and Content API fetches); `validateWebhook` unavailable in `apiKey` mode | `twilio-client.test.ts` |
| the union accepts both shapes and rejects a mixed one; the other mode's keys are pruned; a legacy config without `authMode` normalizes to `authToken`; `webhookSecret` is not in the allowlist | `channels.store.test.ts` |
| existing signature tests stay green; correct secret → 200; wrong secret → 403; secret route on an `authToken` channel → 404 and vice versa; the 403 log line contains no secret | `twilio-webhook.controller.test.ts` |
| reveal builds the URL from `BASE_URL`; rotation changes the secret and the old URL stops working | new `instance-channels.controller.test.ts` |
| an export bundle preserves `authMode` | `export.schema.test.ts` — the test that would have caught the `credentialMode` naming trap |

Web: `whatsapp-channel-card.test.tsx` — switching mode shows the right fields, the URL
panel appears only in API Key mode after saving, regenerate asks for confirmation.

**Local environment constraint:** in this checkout `@polyant-ai/plugin-sdk` and
`radix-ui` are not installed, so a portion of the suite fails to collect on any branch.
Record a baseline on the base commit before making changes and report deltas only. If
`npm install` does not fix the local environment, the web card test is verified in CI and
reported as such — never claimed as locally passing.

## Rollout

- PR from `fix/whatsapp-api-key-auth` into `main`, DCO sign-off on every commit.
- No DB migration, no new environment variable.
- **Zero impact on existing agents**: with no `authMode` in config, route and signature
  behaviour are identical to today.
- **Operational sharp edge for the release note:** when an operator switches a channel to
  API Key mode, inbound is interrupted between saving in Polyant and re-pasting the URL
  in the Twilio Console — the old route answers 404 and Twilio discards those messages.
  This is intrinsic: without an Auth Token the old route cannot be authenticated. Save in
  Polyant, copy the URL, update Twilio, and do it in a low-traffic window.
- **Back-merge `main` → `develop`:** `twilio-client.ts` and `media-fetch.ts` are
  byte-identical across the two branches and merge cleanly; the webhook controller
  conflicts lightly (`develop` added `sanitizeForLog`, prototype-safe param collection
  and a `NumMedia` clamp); the `CHANNEL_CONFIG_KEYS` hunk lands as a no-op; the web card
  must be re-applied by hand under `develop`'s moved path
  (`organizations/[orgSlug]/workspaces/[workspaceSlug]/instances/[slug]/`).
- `CLAUDE.md` gains a bullet describing the two modes.
