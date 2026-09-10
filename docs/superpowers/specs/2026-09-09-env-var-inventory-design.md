# The environment-variable inventory, and which of them are product settings — design

Date: 2026-09-09
Status: inventory complete; nine variables removed; the migrations to settings
are not started

## Problem

Nobody had checked, in one pass, which environment variables the code actually
reads, whether `.env.example` matches, and which of them are configuration of
the PRODUCT wearing the clothes of configuration of the DEPLOYMENT. Until that
list exists, "move this one to a setting" is a guess about a surface nobody has
measured.

This document is the measurement. It changes no behaviour: the only code it
carries is the naming of what was undocumented and the markers on reads that had
none. Which variables become settings, and in what order, is decided from the
table below and done one variable at a time.

## Method, and what it measures

Counted against this worktree (`chore/env-var-inventory`, from `origin/develop`
at `96f62df4`), over `packages/engine/src`, `packages/web/src`,
`packages/web/next.config.ts`, `scripts/` and `infra/`, excluding test and
mock files.

Two read shapes had to be counted, and the second is the one a naive grep
misses:

- `process.env.NAME` — 60 variables. `config.ts` spells every one of its own out
  in the object it hands to `safeParse`, so they are visible to this grep.
- `env.NAME`, where `env` is a `NodeJS.ProcessEnv` parameter defaulting to
  `process.env` — the "default params for testability" convention exception.
  One variable is reachable ONLY this way: `CORS_ORIGINS`, in
  `server/main.ts`'s `getCorsOptions(env = process.env)`.

**61 variables total.** 41 are read inside `config.ts` and validated by its Zod
schema; 20 are read elsewhere — the documented exceptions, web-side reads, build
inputs, dev tooling, and the platform's own `NODE_ENV`.

`.env.example` declared 55 before this change and declares 60 after. No
duplicated blocks (the three that exist in enterprise came from an OSS merge appending a second set of
section headings, and are not present here).

## What was wrong

- **Six variables the code reads were undocumented**: `AWS_REGION`,
  `PUPPETEER_EXECUTABLE_PATH`, `NEXT_PUBLIC_APP_VERSION`,
  `NEXT_PUBLIC_APP_REVISION`, `NEXT_DIST_DIR` and `NODE_ENV`. Three more are
  read only by tooling and belong to no deployment: `CI_REQUIRE_DB`,
  `CDK_STAGE`, `GITHUB_SHA`. All nine are now named in `.env.example` — the last
  four under a heading that says explicitly not to set them.
- **Three reads carried no `// CONVENTION-EXCEPTION:` marker** although two
  neighbours cite one of them as the original: `AWS_REGION` in
  `ai-gateway/providers/bedrock.ts` (cited by `provider-resolver.ts` and
  `memory-status.ts`, both of which do carry markers), `DEBUG_LLM_PAYLOAD` in
  `ai-gateway/providers/base.ts`, and `PUPPETEER_EXECUTABLE_PATH` in
  `agents/tools/markdown-to-pdf.tool.ts`. Markers added with their reason; no
  behaviour changed.
- **`.env.example` mis-stated its own rule.** The `WORKSPACES_ROOT` block called
  itself "one of the two documented `process.env` reads outside `config.ts`".
  There are three: `DEFAULT_INSTANCE_ID`, `WORKSPACES_ROOT` and `LOG_LEVEL`.
- **`LANGSMITH_API_KEY` / `LANGSMITH_PROJECT` / `LANGSMITH_TRACING` are
  documented but read nowhere** — tracing moved to per-instance secrets. Kept in
  `.env.example` deliberately, as the signpost saying so.

### The enforcement that exists, and the half it cannot see

`../docs`'s `scripts/generate-references.mjs` regenerates
`content/reference/env-vars.md` from `.env.example` and **throws** when a
variable is missing from it — which is why the 55 documented ones stayed in
step. But its subject list comes from `configEnvironmentNames(configText)`:
a regex over `config.ts` alone. Every variable read anywhere else is invisible to
it, which is exactly the set that had drifted. Widening that guard to the whole
source tree (with an explicit allow-list for the tooling ones) is the change that
stops this recurring; it is a `../docs` PR, not this one.

## The inventory

The test applied to each: **does the right value depend on the deployment, or on
a tenant/agent?** A value that differs between two organizations sharing one
installation is product configuration wearing env clothes; a value that is a
property of the machine, the network or the release is not.

### Stays env — read before there is a database, or a property of the process

| Variable | Read in | What it decides |
|---|---|---|
| `DATABASE_URL` | `config.ts`, `web/lib/auth.ts` | Full connection string. Web builds its own pool for the Auth.js adapter |
| `POSTGRES_HOST` `_PORT` `_DB` `_USER` `_PASSWORD` | `config.ts`, `web/lib/auth.ts` | Components, used when `DATABASE_URL` is absent. An EMPTY password is a legitimate value (`trust` auth), which is why it is defaulted rather than required |
| `POSTGRES_SSL` | `config.ts` | TLS to Postgres. Only the literal `"true"` enables it, and it gives TLS WITHOUT certificate verification |
| `ENCRYPTION_KEY` | `config.ts` | AES-256-GCM key for `instance_secrets`. 64 hex characters or the process refuses to boot |
| `AUTH_SECRET` | `config.ts`, `engine/test-setup.ts` | Auth.js JWE. Must be byte-identical in both packages |
| `AUTH_INTERNAL_SECRET` | `config.ts`, `web/lib/auth.config.ts`, `web/lib/auth.ts` | Engine↔web credentials endpoint. Unset disables email/password sign-in entirely |
| `AUTH_MODE` | `config.ts` | `session` or `alb-oidc`. The second is REFUSED at boot |
| `AUTH_TRUST_HOST` | `web/lib/auth.config.ts` | Auth.js host trust. Required for any self-hosted deployment |
| ~~`GOOGLE_CLIENT_ID` `_SECRET`~~ | — | **Removed with the Google provider.** Federated sign-in belongs to the tier that manages organizations; `web/lib/auth-providers.ts` is the empty seam left in its place |
| `PLATFORM_ADMIN_EMAIL` | `config.ts`, `web/lib/auth.ts` | The identity promoted to platform admin at every boot. A bootstrap input: it exists to create the identity that can edit everything else |
| `INITIAL_ADMIN_EMAIL` `_PASSWORD` | `config.ts` | First-boot seed. Password unset SKIPS seeding rather than generating one into the logs |
| `DEFAULT_INSTANCE_ID` | `config.ts` (documented exception) | Slug assumed when a caller names no agent |
| `API_PORT` | `config.ts` | Listening port |
| `BASE_URL` | `config.ts` | Public origin of the engine, used to build webhook callback URLs |
| `CORS_ORIGINS` | `server/main.ts` (via `env` param) | Origin allow-list. A credentialed `*` is refused at startup |
| `TRUST_PROXY` | `config.ts` | Trusted `X-Forwarded-*` hops. `0` = trust nothing; otherwise anyone can spoof the host and bypass the Twilio HMAC check |
| `NEXT_PUBLIC_API_URL` | `web/next.config.ts` | Where the panel's rewrites send API calls. Build-time |
| `INTERNAL_ENGINE_URL` | `web/lib/auth.config.ts`, `web/lib/auth.ts` | Server-side address of the engine for the credentials verify call |
| `LOG_LEVEL` | `utils/create-logger.ts` (documented exception) | Verbosity of the structured logger |
| `PLUGIN_DIRS` | `config.ts` | Absolute paths scanned for out-of-tree plugins |
| `WORKSPACES_ROOT` | `workspace/index.ts`, `agents/tools/shared/workspace-utils.ts` (documented exception) | Filesystem root of the per-conversation sandbox |
| `PUPPETEER_EXECUTABLE_PATH` | `agents/tools/markdown-to-pdf.tool.ts` | Path to a browser binary. A property of the IMAGE |
| `AWS_REGION` | `ai-gateway/providers/bedrock.ts`, `embeddings-gateway/provider-resolver.ts`, `server/memories/memory-status.ts` | Region used when the instance declares none of its own. Resolved per call, after the per-instance secret |
| `PLATFORM_S3_BUCKET` `_REGION` `_ACCESS_KEY_ID` `_SECRET_ACCESS_KEY` | `config.ts` | Attachment storage. Absent = attachments are not persisted |
| `NODE_ENV` | `providers/base.ts`, `server/main.ts`, `mcp/mcp-url-guard.ts`, `web/next.config.ts` | The platform's own. Read to refuse debug behaviour in production |
| `NEXT_PUBLIC_APP_VERSION` `_APP_REVISION`, `NEXT_DIST_DIR`, `GITHUB_SHA` | `web/next.config.ts`, `web/lib/release-info.ts` | Panel build inputs, baked into the bundle |
| `CI_REQUIRE_DB`, `CDK_STAGE` | `database/test-db.ts`, `infra/bin/app.ts` | Tooling. `CI_REQUIRE_DB=1` makes an unreachable database FAIL the integration tier instead of skipping it |

### Stays env — bounds that protect the PROCESS from a hung dependency

Their right value comes from the deployment's own capacity, and exposing them
per tenant hands a tenant the lever to exhaust an installation-wide resource.

| Variable | Default | What it bounds |
|---|---|---|
| `AGENT_CALL_TIMEOUT_MS` | 60000 | One sub-agent invocation over the virtual `agent` channel |
| `MCP_CONNECT_TIMEOUT_MS` | 10000 | The per-server connect + list-tools round trip, so one hung MCP server cannot stall every turn |
| `PDF_CONCURRENCY` | 3 | Puppeteer pages rendering in parallel. Each costs ~50-100MB RSS |
| `SCHEDULER_ORPHAN_GRACE_MS` | 900000 | How old a `running` row must be before startup recovery assumes its process is gone. Younger rows are left alone: stealing a live run executes it twice |
| `SCHEDULER_DEFAULT_MAX_RUN_MS` | 1800000 | Per-run deadline when a task declares no `max_run_ms` |
| `SSE_MAX_CONNECTIONS` | 50 | Global cap on concurrent activity-stream subscribers |

### Candidates, in the order the argument is strongest

| Variable | Default | Tier it belongs to | Why it is a candidate |
|---|---|---|---|
| `KNOWLEDGE_MAX_DOCS_PER_INSTANCE` | 500 | organization or agent | A per-instance CAP configured per DEPLOYMENT: the variable's own name says which tier it belongs to. An entitlement in practice |
| `ANALYTICS_RETENTION_DAYS` | 90 | platform | Decides how much history the installation keeps — policy, not capacity, and an admin should be able to change it without a redeploy. Also the one whose wrong value destroys data |
| `DATETIME_TIMEZONE`, `DATETIME_LOCALE` | the runtime's own | agent | An agent serving Italian customers and one serving German customers want different values, and they can already differ at the prompt level — so the env var is the default of a decision the agent already owns |
| `DEDUP_SIMILARITY_THRESHOLD` | 0.90 | agent | Decides when two memories are the same fact: a behavioural property of an agent's memory, not of the host |
| `MESSAGE_SOFT_DEBOUNCE_MS`, `MESSAGE_TYPING_DELAY_MS`, `MESSAGE_MAX_RESTARTS` | 2000 / 1500 / 3 | agent | These shape conversational UX, not capacity. A support agent and a booking agent legitimately want different debounce windows. Cost: the coordinator has to resolve config per conversation |
| `SSE_MAX_CONNECTIONS_PER_USER` | 5 | platform | A limit per USER fixed per deployment. Weaker than the rows above: it protects the process, not the tenant |
| `THROTTLE_ENABLED`, `THROTTLE_TTL_MS`, `THROTTLE_LIMIT` | on / 60000 / 30 | platform, per route family | The per-IP limits are a deployment property; the per-route-family limits are policy. Weak: moving them puts a database read on the hot path |

**Enterprise-only candidates.** `SMTP_*`, `MAIL_FROM` and
`RETENTION_DEFAULT_DAYS` appear in the enterprise analysis but do not exist in
this build. The sign-in domain list is not a candidate here either: federated
sign-in has been removed from this edition altogether, so there is no floor for
a per-organization list to sit on top of — see "Google sign-in is removed" in
`docs/UPGRADING.md`.

## What was removed after the inventory (2026-09-09)

The inventory's first use was not a migration to a setting but a cull: nine of
the 61 were a second name for something the code already had, or a knob whose
only legal value was the default. **61 → 52.**

| Removed | Why it could go |
|---|---|
| `DEFAULT_INSTANCE_ID` | Its five call sites were all dead. `IncomingMessage.instanceId` is required, all three `supervise()` callers pass it, `hybridSearch`'s one caller passes it, and the OpenAI-compatible route validates `model` against a slug regex and answers 400 — so the fallback could not fire. `SupervisorInput.instanceId` and `hybridSearch`'s parameter are now required, which is what makes it stay gone |
| `AUTH_ALLOWED_DOMAIN`, `AUTH_ALLOWED_DOMAINS` | The same list twice: the parser joined both with a comma and split, so the singular already accepted a list. One list for a whole installation cannot answer for a second tenant, and it was a security control an operator had no way to see. The list moves to the organization tier — and with it, in a follow-up, the provider it gated: `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and `isEmailDomainAllowed` are gone too, leaving `web/lib/auth-providers.ts` as an empty seam |
| `AUTH_MODE` | One legal value. `alb-oidc` was refused at boot, so the variable's whole range was the default. Removing it means deleting the mode: `auth/alb-oidc.service.ts`, the guard's gateway branch, and the `AUTH_MODE` the CDK emitted for a stack that could not boot. ADR-0001 is marked reverted rather than edited — the trade-offs it records are the ones a future gateway mode faces again |
| `AWS_REGION` | The region is per-AGENT (`aws_provider_region`). Worse than redundant: the chat path fell back to a hardcoded `us-east-1` while the embedder refused on the same input, and `us-east-1` does not serve the `eu.*` inference profiles this catalog's Bedrock tiers use — so a misconfigured agent got a per-call ValidationException instead of a message naming the setting. Both halves now refuse |
| `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT`, `LANGSMITH_TRACING` | Read by nothing. Kept in `.env.example` as a signpost, which is a job a comment does without three names that look settable |
| `PUPPETEER_EXECUTABLE_PATH` (our read) | Puppeteer reads it itself (`getConfiguration.ts`), verified at runtime: `puppeteer.executablePath()` returns the variable's value. Our `executablePath` argument only duplicated puppeteer's own default. `Dockerfile.engine` still sets it; it is no longer OUR variable |
| `DEBUG_LLM_PAYLOAD` | A development-only switch that dumped the system prompt and a truncated copy of every message to stdout. The per-instance `debug_enabled` flag captures strictly MORE — the full prompt, the full messages array and the tool definitions, as `LlmDebugPayload` — per agent, opt-in, and persisted for analysis rather than printed into a log file the file-logger tees to disk. It also gated a second thing, which is why removing it was not a pure deletion: `logProviderError` logged 2000 raw characters of a provider error body under it. That body can quote the offending content back, so it is now never logged raw — the length, plus the machine-readable error type extracted by `errorBodyReason`, which is the half that names the reason (`ValidationException`, `invalid_request_error`) and carries no free text |

`WORKSPACES_ROOT` survived, for a reason the inventory had missed: it is the
seam `read-file.tool.fifo.test.ts` uses to move the sandbox into a tmpdir, which
that test needs because a FIFO wants a real filesystem. It is documented as a
test seam and removed from `.env.example` — the answer to "why would an operator
change this" is that they would not.

### Two unifications in the same pass

- **The connection string was assembled three times.** Two in `config.ts`
  (complementary: one parses `DATABASE_URL`, one builds it) and a third in
  `web/lib/auth.ts`, inline at its call site, with a different scheme
  (`postgres://` vs `postgresql://`). Both `POSTGRES_*` and `DATABASE_URL` stay:
  the CDK wires each `POSTGRES_*` from a separate field of the Aurora secret and
  cannot read a secret's value at synth to build a URL, while a managed provider
  hands you the URL. The panel imports nothing from the engine, so one copy per
  package is the floor — each now written once and pinned by a suite asserting
  the SAME answers. Both also **percent-encode the credentials**, which
  `parseDatabaseUrl` already assumed by decoding them: interpolated raw, a
  password containing `@` or `/` produced a URL that parses as a different host.
- **`BASE_URL` is resolved once.** Four callers each wrote
  ``baseUrl ?? `http://localhost:${port}` `` — four chances to disagree about
  what unset means. A transform on the `server` object fills it after `port`
  defaults, so `config.server.baseUrl` is a `string`.

## The pattern each migration follows

The shape part 1 of the enterprise spec used for the SSO domains, and the one
dev mode used when `DEV_MODE_ENABLED` was retired:

1. The env var **stays**, as the deployment floor or the fallback. No existing
   deployment changes behaviour on upgrade.
2. The product value is DATA, at the tier that actually differs.
3. The resolver **fails closed** and lives in exactly one place.
4. The mutation is audited, because a value that decides access or retention has
   to be attributable afterwards.

Anything following those four moves one variable at a time, without a
release-wide migration. Each move also updates `../docs` — both the generated
env-vars reference and the product page describing where that thing is now
configured — in the same pass, not once at the end.

## Alternatives considered

- **Delete the env var when the setting lands.** Rejected: it makes the upgrade
  a breaking change for every existing deployment, and turns a per-variable move
  into a release-gated one.
- **One `platform_settings`-style migration for all of them at once.** Rejected
  for the same reason the issue splits them: the candidates differ in tier
  (platform, organization, agent), and a single table would force the weakest
  argument in the list to justify the strongest one's schema.
- **Widen the docs generator's guard in this pass.** Deferred, not rejected: it
  lives in `../docs` and is the right fix, but it belongs to its own PR where it
  can be tested against both this repo and enterprise.
