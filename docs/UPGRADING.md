# Upgrading Polyant

This guide covers upgrades that need an operator decision. For the full list of
changes see the [changelog](../CHANGELOG.md).

## Upgrading from 1.2.0

### Migration 0086 rewrites the conversations table

Conversations now carry their own message counters, which the conversation list
and the analytics read instead of counting messages. Migration 0086 fills them
from history in one pass and adds two indexes, one of them on
`conversation_messages`. Writes to conversations and messages wait while it runs:
on a test database with 2 million messages it took 8 seconds, and it grows with
the size of `conversation_messages`. On a large installation, either schedule the
deploy for a quiet moment or build the two indexes beforehand without blocking —
the migration then skips them:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_conversations_instance_last_message"
  ON "conversations" ("instance_id", "last_message_at");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_conversation_messages_conversation_created"
  ON "conversation_messages" ("conversation_id", "created_at");
```

The counter backfill itself always runs in the migration.

### Extracted tools keep their enablement

Migration 0087 renames the catalog rows of the tools that moved into plugins
(HubSpot, GitHub, Render, Markdown-to-PDF) to their namespaced names, so agents
keep them enabled and skills keep their links. It recovers nothing on an
installation whose first boot already removed the old rows; see
[Install and re-enable extracted tools](#install-and-re-enable-extracted-tools).

### Storing attachments is now a per-agent choice

In 1.2.0 an agent whose `fileUpload` secrets name a bucket copied every file a
user sent into that bucket, and nothing deleted them. Migration 0088 adds a
switch for it, **Store attachments** under the agent's behaviour parameters, and turns it
off on every agent. Turn it on where the conversation view should reopen the
files. With it off the model still sees each file in the turn; it just is not
kept.

Deleting a conversation or an agent now also deletes the files stored for it,
by the keys recorded on its messages. That needs `s3:DeleteObject` on the
`attachments/` prefix for the agent's credentials or task role; a refused
delete is logged and leaves the files in place, and never blocks the database
delete. Files stored by earlier versions for conversations already deleted are
not tracked anywhere and stay in the bucket.

### A second, smaller database pool for analytics

Dashboards and other analytics reads now use their own connection pool, so a
heavy aggregate can no longer take the connections a conversation turn is
waiting for. Each engine process therefore opens up to 3 more connections to
Postgres (`POSTGRES_ANALYTICS_POOL_MAX`); check your server's `max_connections`
if it is tight. Statements on that pool stop after 15 seconds
(`POSTGRES_ANALYTICS_STATEMENT_TIMEOUT_MS`). The main pool keeps its 10
connections and is now configurable with `POSTGRES_POOL_MAX`.

### Agents that map web context need their key on every web turn

A request's call `context` is written into the state of the conversation its
`chat_id` names, and later turns of that conversation read it. On an agent with
authentication off, a turn without the key could therefore continue a
conversation a keyed request had started and act as the identity its context
set. An agent with at least one context field mapped now requires its API key on
every request to `/v1/chat/completions` and to the chat stream, whatever the
authentication switch says. Agents that map no context field are unchanged.
Before upgrading, give the key to every client of such an agent, including the
Playground's token field.

### Running more than one engine replica

The engine is built to run as one replica. Several parts of it keep their state
in the process, so with two or more replicas behind a load balancer the
following happen. Run one replica, or accept these effects:

- **Live views miss writes made elsewhere.** Following a conversation live and
  the Playground's activity feed listen to events raised in the process that
  handled the write. A turn answered by another replica appears only on reload.
- **A channel change reaches only the replica that saved it.** Saving a
  Telegram, Slack or WhatsApp channel starts its adapter on the replica that
  handled the request. The others keep the previous adapter, or none for a new
  channel, until they restart: their webhooks answer 404 for a new channel and
  refuse a rotated Telegram token's secret. Restart every replica after
  changing a channel.
- **Fragments of one message burst can be answered separately.** WhatsApp and
  Telegram messages that arrive close together are merged into one turn per
  process. Fragments that land on different replicas each get their own reply.
- **A redelivered webhook can be processed twice.** Telegram and Slack
  redeliveries are dropped by the replica that saw the first copy; a retry that
  reaches another replica runs the agent again.
- **Rate limits apply per replica.** Each replica counts requests on its own, so
  the effective limit is the configured one times the number of replicas.

Scheduled tasks are safe across replicas: each run is claimed in the database.

## Upgrading from 1.1.x to 1.2.0

### Node 24

The engine and the panel now run on Node 24, the active LTS. The published
Docker images carry it, so a deployment that uses them needs nothing. If you
run from source or build your own images, move to Node 24 (`.nvmrc` names it);
Node 22 is no longer tested.

### Running the migrations without starting the engine

The engine image migrates and starts in one step: its entrypoint runs
`migrate.js` and then boots the engine. Some of the steps below have to happen
after the schema is current and before the new engine serves anything, so run the
migrations on their own first, with the same environment the engine gets:

```bash
docker run --rm --env-file .env --entrypoint node <engine-image> \
  packages/engine/dist/database/migrate.js
```

It prints `Migrations applied successfully.` and exits; starting the engine
afterwards finds nothing left to apply. On ECS, a `RunTask` override can replace
the command but not the entrypoint, so register a task definition revision whose
container sets `entryPoint` to `["node"]` and `command` to
`["packages/engine/dist/database/migrate.js"]`, and run that once. From source,
`npm run db:migrate` does the same.

### Telegram and Slack need a public address

Telegram and Slack no longer open a connection out of the engine: their messages
arrive as webhooks, like WhatsApp's. Before upgrading a deployment that runs
either channel:

1. Make sure the engine has a public HTTPS address (`BASE_URL`, or the address in
   Settings → General) and that `/webhooks/*` reaches the engine. The CDK stack
   routes it; a hand-built proxy or load balancer needs the rule, without any
   sign-in in front of it — each webhook authenticates the caller itself.
2. For each Slack app: switch Socket Mode off, and under Event Subscriptions set
   the Request URL to `<public address>/webhooks/slack/<agent slug>`. The signing
   secret the channel already holds verifies the requests; the app-level token is
   no longer used.
3. Telegram needs nothing by hand: the engine registers its webhook when the
   channel starts. Telegram keeps undelivered updates for 24 hours, so messages
   sent while the address was unreachable arrive once it is.

### Review agents without a pinned model

The default tiers changed for two providers. The OpenAI `fast`, `standard` and
`heavy` tiers now resolve to `gpt-6-luna`, `gpt-6-sol` and `gpt-6-astra`, and the
Bedrock `standard` and `heavy` tiers to Amazon Nova Pro and OpenAI gpt-oss 120B.
Agents with an explicit model stay pinned, but unpinned conversations and
background work change model and price. Review their model settings before
deploying.

Each changed default moves to a different model family. Prices are the 1.2.0
catalog's, in USD per million input / output tokens:

| Provider | Tier | 1.1.x | 1.2.0 |
| --- | --- | --- | --- |
| OpenAI | `fast` | `gpt-4o-mini` ($0.15 / $0.60) | `gpt-6-luna` ($0.10 / $0.50) |
| OpenAI | `standard` | `gpt-4o` ($2.50 / $10) | `gpt-6-sol` ($2 / $10) |
| OpenAI | `heavy` | `o3` ($2 / $8) | `gpt-6-astra` ($10 / $50) |
| Bedrock | `standard` | `eu.anthropic.claude-sonnet-4-6` ($3.30 / $16.50) | `eu.amazon.nova-pro-v1:0` ($0.80 / $3.20) |
| Bedrock | `heavy` | `eu.anthropic.claude-opus-4-8` ($5.50 / $27.50) | `openai.gpt-oss-120b-1:0` ($0.20 / $0.79) |

What each tier reaches decides who is affected. `standard` answers the turn of
every agent with no model of its own, and every `spawnTask` sub-agent, pinned
agent or not, because a sub-agent always runs on its provider's `standard` tier.
`fast` runs the background jobs (history summaries, memory extraction, prompt
section updates, room compaction) of every agent on the provider, pinned or not.
Nothing in the core engine calls `heavy`; it matters only to code of your own
that asks for it.

On Bedrock, Nova Pro does not reason: an unpinned agent with thinking enabled
stops reasoning on its turns and in its sub-agents, with no error. gpt-oss 120B
has no vision and no prompt caching, and it is a plain on-demand model id
rather than an `eu.` inference profile, so whether a region serves it has to be
checked per region (the catalog verified it in eu-south-1 only). On OpenAI, the
GPT-6 models do not take a custom temperature, and `gpt-6-astra` always reasons.

To pin an agent to the model it ran on before, set the model in its settings.
This lists the agents that have none, by provider (no provider means OpenAI):

```sql
SELECT coalesce(provider, 'openai') AS provider,
       count(*) AS agents,
       string_agg(slug, ', ' ORDER BY slug) AS slugs
FROM instances
WHERE model IS NULL
GROUP BY 1
ORDER BY 1;
```

### Install and re-enable extracted tools

The GitHub, Render, HubSpot and Markdown-to-PDF tool families no longer ship in
the core image. If an agent uses one of them, add its plugin to the image before
building (see [Loading a plugin — build-time](plugins.md#loading-a-plugin--build-time)),
or use `PLUGIN_DIRS` in development.

Plugin tools have namespaced names: `ghIssue`, `ghPR` and `gitCloneRepo` are now
`github:issue`, `github:pr` and `github:cloneRepo`; `renderService` is
`render:renderService`; each `hubspotX` tool is `hubspot:x` (`hubspotContact` is
`hubspot:contact`, `hubspotSendEmail` is `hubspot:sendEmail`); and
`markdownToPdf` is `extra:markdownToPdf`. Migration `0087_rename_extracted_tools`
renames the catalog rows in place, so every agent keeps its enablement and every
skill its tool links and its list of required tools. Until the plugin is
installed the agent simply does not get the tool; once it is, the tool works
again with nothing to re-enable. An export bundle from an older version that
names a tool by its old name enables the new one on import.

The integration-specific `verifyDocument` tool was removed without a
replacement. The first boot removes it, and every other tool that no loaded
plugin provides, from the agents that had it enabled, and logs the names of
those tools once.

An installation that already booted a version without the extracted tools and
without this migration has lost those enablements: the migration finds no old
rows to rename. Re-enable the tools from each affected agent's Tools tab after
installing the plugins, and update any skill that still names an old tool.

### Custom S3 endpoints are removed

`s3_endpoint` is no longer read, and migration `0081_drop_s3_endpoint_secret`
deletes every stored value. An agent configured for MinIO, Cloudflare R2 or
another S3-compatible endpoint falls back to AWS addressing, so uploads and
attachment reads will fail rather than continue against that service.

Before upgrading, move affected buckets to AWS S3 and configure each agent with
`s3_bucket_name`, `aws_region`, and either static AWS credentials or
`s3_use_task_role`. Version 1.2.0 has no supported custom-endpoint replacement.

### Google sign-in is removed

The Google provider, its two variables, the login button and the domain-allowlist
callback are all gone. Single sign-on is a capability of the tier that manages
organizations: which domains may sign in is a question about a tenant, and one
list for a whole installation cannot answer it for a second one.

**Before upgrading, make sure every account that needs access has a password.**
An account that only ever signed in with Google has none, and there is no
federated provider left to authenticate it. A platform admin can set one from
Users, and `INITIAL_ADMIN_EMAIL` + `INITIAL_ADMIN_PASSWORD` still recover an
installation whose only administrator is locked out — on a non-empty database the
seeder sets a password on a **password-less** account and promotes it, and never
overwrites one that already exists.

### Environment variables that are gone

Each of these was configuration of the PRODUCT wearing the clothes of
configuration of the deployment, or a second name for something the code already
had. Remove them from your environment; none of them needs a replacement value.

| Removed | What to do instead |
| --- | --- |
| `AUTH_MODE` | Nothing. `session` was the only value that booted, and gateway mode is deleted — see [ADR-0001](adr/0001-gateway-authenticated-mode.md). A stack whose CDK config sets `auth:` no longer receives this variable; it was already refused at startup |
| `AUTH_ALLOWED_DOMAIN`, `AUTH_ALLOWED_DOMAINS` | Federated sign-in is no longer restricted by a deployment-wide domain list. The two variables were one list twice (the parser concatenated them), and the restriction belongs to the organization |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Nothing, and read the next paragraph first: **federated sign-in is gone from this edition entirely**, not merely unconfigured. Email and password is the only way in |
| `AWS_REGION` | Set the AWS provider region on each agent (Settings → AI Provider). There is no deployment-wide fallback and no `us-east-1` default: a Bedrock agent with no region configured is now refused with a message naming the setting, on chat as well as on embeddings |
| `DEFAULT_INSTANCE_ID` | Nothing. Every caller already names its agent — the OpenAI-compatible route validates `model` and answers 400 without it — so the fallback could not fire |
| `WORKSPACES_ROOT` | Nothing. The per-conversation sandbox stays under `packages/engine/workspaces`; the variable survives only as a test seam and is no longer documented as deployment configuration |
| `PLATFORM_ADMIN_EMAIL` | Nothing, on an installation that already booted with it: the standing it granted lives in `users.is_platform_admin` and stays. The platform admin is now the account `INITIAL_ADMIN_EMAIL` names, seeded already privileged and made Owner of the default organization on the same boot. The internal `POST /api/auth/credentials/bootstrap-owner` endpoint it needed is gone with it |
| `DEBUG_LLM_PAYLOAD` | Enable debugging on the individual agent instead. The per-agent capture includes the full prompt, messages and tool definitions and stores them for inspection instead of writing sensitive payloads to stdout |
| `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT`, `LANGSMITH_TRACING` | Nothing. They were read by no code at all; tracing is configured per agent |

### Bedrock agents need a region of their own

Until 1.1.x a Bedrock agent with no region of its own used `AWS_REGION`, and
then `us-east-1`. Both fallbacks are gone, so after the upgrade such an agent
fails every chat turn, and every embedding if its knowledge or memory runs on
Bedrock, with an error naming the setting. Before upgrading, list the agents
that use Bedrock for chat or embeddings and hold no region, and set the region
in each one's Settings → AI Provider:

```sql
SELECT i.slug, i.provider, i.embedding_provider
FROM instances i
WHERE (i.provider = 'bedrock' OR i.embedding_provider = 'bedrock')
  AND NOT EXISTS (
    SELECT 1 FROM instance_secrets s
    WHERE s.instance_id = i.id AND s.key = 'aws_provider_region'
  )
ORDER BY i.slug;
```

The region is stored encrypted, so the query can only check that one is set. Settings → AI Provider exists in 1.1.x too, so this can be done on the
running installation.

### Environment variables the panel now answers

Each of these set one value for a whole installation, for a question an
administrator now answers where it belongs: on the agent, on the organization, or
on the installation's own settings page. The shipped defaults did not change, so
an installation that set none of them behaves exactly as before. Remove them from
your environment — a value left there is read by nothing.

| Removed | Where the value lives now |
| --- | --- |
| `DATETIME_TIMEZONE`, `DATETIME_LOCALE` | The agent's Settings → Behaviour overrides. An agent that declares neither formats dates in the runtime's zone and locale, so a deployment-wide zone is now `TZ` |
| `DEDUP_SIMILARITY_THRESHOLD` | The agent's Settings → Behaviour overrides; the default is 0.90 |
| `MESSAGE_SOFT_DEBOUNCE_MS`, `MESSAGE_TYPING_DELAY_MS`, `MESSAGE_MAX_RESTARTS` | The agent's Settings → Behaviour overrides; the defaults are 2000 ms, 1500 ms and 3 |
| `KNOWLEDGE_MAX_DOCS_PER_INSTANCE` | The organization's knowledge-document entitlement; the default is 500 per agent |
| `ANALYTICS_RETENTION_DAYS`, `SSE_MAX_CONNECTIONS_PER_USER` | Settings → General, for a platform admin; the defaults are 90 days and 5 connections |
| `PDF_CONCURRENCY` | The Markdown-to-PDF plugin, which reads it itself and documents it in its own README |

If you deploy with the CDK stack, drop `defaultInstanceId` and `locale` from the
`app` block of your `config.yaml`; `timezone` stays and is passed as `TZ`.

### Set a customised analytics retention before upgrading

`ANALYTICS_RETENTION_DAYS` is no longer read from the moment the new engine
starts, and the first housekeeping run comes about 30 seconds after every start
of the engine. It deletes logs, traces, tool audit records, hook executions,
task runs and completed event backlog older than the installation's retention,
which is 90 days until someone sets it. An installation that kept more than 90
days therefore loses the difference on the first boot, before anyone can open
Settings → General.

If you set `ANALYTICS_RETENTION_DAYS` to more than 90, store the same value in
the database before upgrading. On the 1.1.x database, run the following,
replacing `365` with your value. The table is the one migration `0080` creates,
defined the same way, so the migration finds it and keeps the row:

```sql
CREATE TABLE IF NOT EXISTS "platform_settings" (
  "id" boolean PRIMARY KEY DEFAULT true,
  "analytics_retention_days" integer,
  "sse_max_connections_per_user" integer,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "platform_settings_single_row" CHECK ("id"),
  CONSTRAINT "platform_settings_analytics_retention_days_positive"
    CHECK ("analytics_retention_days" IS NULL OR "analytics_retention_days" > 0),
  CONSTRAINT "platform_settings_sse_max_connections_per_user_positive"
    CHECK ("sse_max_connections_per_user" IS NULL OR "sse_max_connections_per_user" > 0)
);
INSERT INTO "platform_settings" ("id", "analytics_retention_days") VALUES (true, 365)
  ON CONFLICT ("id") DO UPDATE SET "analytics_retention_days" = EXCLUDED."analytics_retention_days";
```

The statements are safe to run twice, and safe on a database that is already
migrated. Alternatively, run the migrations on their own (see above), then
`UPDATE platform_settings SET analytics_retention_days = 365;`, then start the
engine. Settings → General shows the stored value afterwards.

### Dates and cron schedules follow the process time zone

`DATETIME_TIMEZONE` and `DATETIME_LOCALE` are no longer read. The date an agent
sees in its prompt now comes from the agent's own setting in Settings →
Behaviour, or else from the process: the `TZ` zone and the ICU default locale
(`LANG`/`LC_ALL`, else the system's). An installation that set the two variables
and no per-agent value sees its agents' dates in the process zone and locale
until you either set `TZ` (and the locale) on the engine or set them per agent.

Setting `TZ` has a second effect. A cron task with no time zone of its own runs
in the process zone, so on an engine that used to run in UTC, setting
`TZ=Europe/Rome` moves every such task by the zone's offset: `0 9 * * *` runs at
09:00 Rome time instead of 09:00 UTC. The CDK stack now passes `app.timezone` as
`TZ`, so a CDK deployment makes this change on upgrade. The next run already
scheduled keeps its time; the ones after it are computed in the new zone. This
lists the cron tasks that have no zone:

```sql
SELECT instance_id AS agent, name, schedule->>'expression' AS cron, enabled, next_run_at
FROM scheduled_tasks
WHERE schedule->>'type' = 'cron'
  AND coalesce(schedule->>'timezone', '') = ''
ORDER BY 1, 2;
```

To keep a task on UTC, open it in the agent's Automation → Scheduled section and
save it: the form fills in `UTC` for a task that has no zone. Leaving `TZ` unset
keeps every such task on the container's zone, UTC in the published image.

### Operational limits move to Settings → General

Seven more variables become rows an administrator edits, with the defaults they
had: `SSE_MAX_CONNECTIONS` (50), `THROTTLE_TTL_MS` (60000), `THROTTLE_LIMIT`
(30), `AGENT_CALL_TIMEOUT_MS` (60000), `MCP_CONNECT_TIMEOUT_MS` (10000),
`SCHEDULER_ORPHAN_GRACE_MS` (900000) and `SCHEDULER_DEFAULT_MAX_RUN_MS`
(1800000). If your deployment set any of them to something other than the
default, set the same number in Settings → General: the new engine does not read
the variable, so the default applies from its first start until you do. To have
the values in place from the start, run the migrations on their own, set the
columns of `platform_settings`, then start the engine.

`THROTTLE_ENABLED` stays an environment variable and keeps its meaning.

### The engine's public address

`BASE_URL` is still read, and still the value a fresh installation boots with;
unset still means `http://localhost:<API_PORT>`. What is new is that
Settings → General can hold a public address, and that one wins where it is
set — so an engine that is announcing the wrong webhook URLs is now a form to
correct rather than a redeploy. Nothing to do on upgrade: with no address
stored, `BASE_URL` is what every URL is built from, exactly as before.

## Upgrading from 1.0.0 to 1.1.0

This release changes authorization, the persisted record of platform-admin
standing, and the frontend URL scheme. Read the whole section before starting:
two of the steps have to happen in a specific order, and one of them logs
everybody out.

### 0. Audit `POSTGRES_SSL` first — it decides whether the deploy connects at all

`POSTGRES_SSL` used to be parsed with a coercion that treated **every** non-empty
value as true: `POSTGRES_SSL=false` switched TLS **on**, the opposite of what it
says. That is fixed — only the literal `"true"` enables TLS now — and the fix
changes behaviour for anyone who was relying on the old reading, before any
migration runs:

- **`POSTGRES_SSL=false` on managed Postgres (Aurora/RDS/Cloud SQL): the deploy
  fails to connect.** TLS was silently on and is now off; `pg_hba` rejects the
  connection with *"no encryption"*. Set `POSTGRES_SSL=true`.
- **`POSTGRES_SSL=1`, `TRUE`, `require`, `yes`: the engine exits at boot.** The
  value is validated against `true`/`false` now, with no fallback. Rewrite it.

Unset is still the same as `false`. Check every environment — this is the one
change in the release that bites before the migrations even start.

### 1. This release is NOT a rolling upgrade — stop, then start

The engine applies migrations at container start (`docker-entrypoint.sh` runs
`migrate.js` and then boots), so migration and code are atomic **per container**
but not across replicas. Two migrations in this release make an overlapping
deploy unsafe:

- **`0071_platform_admin_role_value`** rewrites `users.role` from `superadmin` to
  `platform_admin`. The code that accepts both spellings ships in this release,
  so new code reads old and new data correctly — but an **old** replica still
  running alongside knows only `superadmin`, and it classifies every platform
  admin as an ordinary user. While both versions serve traffic, platform admins
  get intermittent 403s depending on which replica answers.
- **`0073_instance_mcp_servers`** and **`0074_add_a2a_enabled`** add columns the
  new code reads unconditionally. Starting the new code *before* the migration
  fails every agent read with `42703` (undefined column).
- **`0076_drop_users_role`** reconciles `is_platform_admin` from the role column
  one last time and then **drops `users.role`**. An old engine replica names
  `role` in the SELECT and INSERT lists of `listUsers`, `insertUser` and
  `countPlatformAdmins`, so the whole users API fails with `42703` the moment
  the migration lands. An old *web* replica is affected too, and less obviously:
  nothing in the panel reads a role any more, but its Auth.js Drizzle mirror of
  the `users` table still declares the column and selects it on **every** query
  the adapter makes — credential sign-in fails there, not just the Admin
  Console.

Deploy with a **stop-then-start** (or single-replica) strategy so exactly one
version serves traffic at a time. Do not use blue/green or a rolling update with
overlap. The condition is transient — it clears as soon as the last old replica
drains — and no data is lost either way.

### 2. There is no rollback past `0071` or `0076`

Neither migration has a down migration, and between them they leave nothing for
an older image to read. `0071` rewrites `users.role` from `superadmin` to
`platform_admin`, which the 1.0.0 image does not recognise; `0076` then drops the
column outright, so the 1.0.0 image fails with `42703` on every read of the users
table. Re-adding the column by hand produces an empty one that no code writes,
and every account reads as an ordinary user.

The only rollback is restoring the database backup. **Take one before you
start**, and treat everything from `0071` onward as forward-only, `0076`
included.

### 3. Force every user to sign in again

`orgId` is stamped into the session JWT **at sign-in only**. Anyone signed in
across the upgrade keeps a token without that claim and is denied on every
organization-scoped management route for the remaining life of the token (up to
24 hours).

Rotate `AUTH_SECRET` as part of the deploy (or clear the `sessions` table). Every
user gets a login prompt once and a correct token thereafter. This is not
optional — without it the panel appears broken for already-signed-in users.

Platform-admin standing is the exception from here on: it is read from the
database on every request instead of being carried on the token, so promoting or
revoking an account takes effect within the five-minute platform-admin cache
window, with no sign-out. Organization membership still travels on the token and
still needs one.

### 4. Check who can reach what, before you announce the upgrade

Three authorization changes take effect immediately:

- **RBAC is enforced unconditionally.** `AUTHZ_ENFORCE` no longer exists; remove
  it from your environment. If your install previously copied the sample `.env`
  with `AUTHZ_ENFORCE=false`, every permission check was a no-op until now —
  expect denials that were previously silent passes, and verify each role can
  still do its job.
- **`AUTH_MODE=alb-oidc` deployments must switch to `AUTH_MODE=session`.** A
  gateway-forwarded identity carries no organization and holds no role bindings,
  so under enforced RBAC it is denied on every management route with no runtime
  remedy. The engine now **refuses to boot** on `alb-oidc` rather than starting a
  panel that 403s on every call — change the variable before you deploy.
- **Member gained `agent.secret:write`** (migration `0072`). Every existing
  Member can now write provider API keys and channel bot tokens, and export an
  agent's full configuration bundle. Secrets stay write-only through the API
  (reads return key names only), but if that is wider than you want, review your
  Member assignments before upgrading — the migration applies to every
  organization with no opt-out, and there is no down migration: narrowing it
  again means editing the role's permissions by hand.

Users created after RBAC first shipped may hold no organization membership at
all (sign-in no longer provisions one). A platform admin grants it with
`PUT /api/organizations/:orgSlug/members/:userId`, or from the Members page.

**After granting it, that user must sign out and back in.** `orgId` is written
into the session token at sign-in and never refreshed, so a membership added (or
moved to a different organization) mid-session is invisible until the token is
replaced — the user keeps getting 403s from a cross-organization scope mismatch,
and reloading the page does not help. Tokens live 24 hours, so the condition
clears on its own within a day, but tell the person to sign out rather than wait.

### 5. Tell users their bookmarks are gone

Frontend URLs are tenant-scoped now, and the legacy flat paths are **not**
redirected: `/instances`, `/conversations/<id>`, `/playground`, `/members` and
friends return a 404 page, as do stale `?tab=` values on the agent detail page.
The canonical form is
`/organizations/<org>/workspaces/<workspace>/…`. Point people at the
organization dashboard and let them re-bookmark.

### 6. If you automate user creation, move off `role`

`POST /api/users` and `PATCH /api/users/:id` take `isPlatformAdmin: boolean` and
no longer return `role`. `role` is still accepted **on input** for one release,
as a deprecated alias for both legacy spellings (`platform_admin` and
`superadmin`), and is never persisted or echoed back. Any script that reads
`role` off a response is already broken by this release; any script that sends it
has one release to switch.
