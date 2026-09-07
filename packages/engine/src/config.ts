// SPDX-License-Identifier: AGPL-3.0-or-later

import dotenv from "dotenv";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { asInstanceSlug } from "./instances/identifiers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// .env: first in package root (packages/engine/), then in monorepo root
const packageEnv = resolve(__dirname, "../.env");
const monorepoEnv = resolve(__dirname, "../../../.env");

if (existsSync(packageEnv)) {
  dotenv.config({ path: packageEnv });
} else if (existsSync(monorepoEnv)) {
  dotenv.config({ path: monorepoEnv });
} else {
  dotenv.config();
}

/**
 * `VAR=` in a `.env` file arrives as `""`, never `undefined` — and Zod's
 * `.optional()` accepts only `undefined`, while `.default()` fires only on
 * `undefined`. So an input the sample documents as skippable ("Leave empty for
 * no promotion") was either rejected outright or silently coerced to a wrong
 * value: `Number("")` is `0`, so `MESSAGE_SOFT_DEBOUNCE_MS=` meant 0ms, and
 * `DATETIME_TIMEZONE=` made `Intl` throw on every LLM turn.
 *
 * Mapping `""` → `undefined` across the WHOLE input is the fix, not a per-field
 * whitelist: a whitelist has to be extended by whoever adds the next optional
 * var, and that is precisely the person who does not know the trap exists.
 *
 * Arrays pass through untouched — `plugins.dirs` is already split and filtered
 * before it reaches here, and an empty entry there is a different question.
 */
function stripEmptyStrings(value: unknown): unknown {
  if (value === "") return undefined;
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        stripEmptyStrings(entry),
      ]),
    );
  }
  return value;
}

const configSchema = z.preprocess(stripEmptyStrings, z.object({
  // Database
  postgres: z.object({
    host: z.string().default("localhost"),
    port: z.coerce.number().default(5432),
    database: z.string().default("polyant"),
    user: z.string().default("polyant"),
    // Defaulted, not required: a local Postgres on `trust` auth has no password,
    // and `POSTGRES_PASSWORD=` is how an operator says so. Without the default,
    // `stripEmptyStrings` would turn that into a boot failure.
    password: z.string().default(""),
    databaseUrl: z.string(),
    /**
     * TLS to Postgres. Only the literal `"true"` enables it.
     *
     * NOT `z.coerce.boolean()`, which is `Boolean(value)` and so treats
     * `"false"`, `"0"` and `"no"` as TRUE — the natural way to switch this off
     * used to switch it on, contradicting `.env.example`. The `trustProxy`
     * comment below already documents the same trap.
     *
     * CAVEAT: enabling this gives TLS WITHOUT certificate verification
     * (`database/client.ts` passes `rejectUnauthorized: false`), so it defeats a
     * passive listener but not an active MITM. Noted in `.env.example`;
     * verifying the chain needs a CA bundle this config does not take yet.
     */
    ssl: z
      .enum(["true", "false"])
      .default("false")
      .transform((v): boolean => v === "true"),
  }),

  // Memory (pgvector)
  memory: z.object({
    dedupSimilarityThreshold: z.coerce.number().default(0.90),
  }),

  // HTTP Server (NestJS)
  server: z.object({
    port: z.coerce.number().default(4000),
    baseUrl: z.string().optional(),
    /**
     * Express `trust proxy` setting. Controls whether `X-Forwarded-*` headers
     * are honored (e.g. for Twilio webhook URL reconstruction).
     *
     * Accepts:
     *   - a non-negative integer = number of trusted proxy hops between this
     *     process and the public internet (typical: `1` behind Render/Railway)
     *   - `"true"` / `"false"` to enable/disable globally
     *
     * Default `0` = trust nothing. Anyone can otherwise spoof
     * `X-Forwarded-Host`/`-Proto` and bypass the Twilio HMAC check.
     */
    trustProxy: z
      .union([z.coerce.number().int().min(0), z.enum(["true", "false"])])
      .default(0)
      .transform((v): number | boolean => {
        if (typeof v === "number") return v;
        return v === "true";
      }),
    // Per-IP rate limiting (@nestjs/throttler). Enabled by default; set
    // THROTTLE_ENABLED=false to disable ALL throttling (global default + every
    // per-route @Throttle override) — intended for parallel dev/eval runs that
    // would otherwise trip the limits from a single IP. Only the literal "false"
    // disables (z.coerce.boolean() would treat "false" as true).
    throttle: z.object({
      enabled: z
        .string()
        .optional()
        .transform((v) => v !== "false"),
      ttlMs: z.coerce.number().int().positive().default(60_000),
      limit: z.coerce.number().int().positive().default(30),
    }),
  }),

  // Encryption (AES-256-GCM requires a 32-byte key = 64 hex characters)
  encryption: z.object({
    key: z.string().regex(
      /^[0-9a-fA-F]{64}$/,
      "ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes for AES-256-GCM)",
    ),
  }),

  // Datetime (used in supervisor system prompt)
  datetime: z.object({
    // No explicit DATETIME_TIMEZONE / DATETIME_LOCALE → follow the runtime zone/locale
    // (driven by TZ and LANG/LC_ALL respectively, else the system defaults).
    // resolvedOptions() reflects the env vars set before Node started.
    timezone: z.string().default(Intl.DateTimeFormat().resolvedOptions().timeZone),
    locale: z.string().default(Intl.DateTimeFormat().resolvedOptions().locale),
  }),

  // Auth (Auth.js JWT decryption + credentials provider)
  auth: z.object({
    secret: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
    /** Shared secret between web and engine for the internal credentials endpoint.
     *  When unset, /api/auth/credentials/verify is disabled (only Google login works). */
    internalSecret: z.string().min(16).optional(),
    /** Auth source: "session" (Auth.js JWT) or "alb-oidc" (trust ALB x-amzn-oidc-data header).
     *  Use "alb-oidc" when deployed behind an AWS ALB with OIDC authentication — the ALB
     *  has already authenticated the user, so the engine trusts the forwarded claims.
     *
     *  "alb-oidc" is currently REFUSED at boot rather than accepted: since RBAC
     *  became unconditional, a gateway-forwarded principal carries no `orgId` and
     *  holds no role bindings, so it is denied on every `@RequirePermission`
     *  route (see `authz/permission.guard.ts`). Accepting the value would boot a
     *  panel that looks healthy and 403s on every management call; refusing it
     *  names the problem while the operator can still act on it. Restore the
     *  value here once the gateway identity is mapped onto a local user. */
    mode: z.enum(["session", "alb-oidc"]).default("session"),
    /** RBAC: the user with this email is promoted to Platform Admin on boot by
     *  the OrganizationsModule bootstrap. It sets `is_platform_admin = true` and
     *  nothing else — that flag is the sole authority for platform-admin
     *  standing, read from the database on every request, and the panel renders
     *  the account from the same flag. Idempotent; unset = no promotion
     *  (migration 0076 reconciles any pre-existing platform-admin user before
     *  the old `users.role` column is dropped). */
    platformAdminEmail: z.string().email().optional(),
  }),

  // NOTE: there is no `authz.enforce`. RBAC is enforced unconditionally — see the
  // class docblock in `authz/permission.guard.ts` for why the `AUTHZ_ENFORCE`
  // escape hatch was deleted rather than defaulted.

  // Initial admin user — created on first boot if the users table is empty.
  // INITIAL_ADMIN_PASSWORD is REQUIRED to seed: `users/seed.ts` skips seeding
  // when it is absent rather than auto-generating a password, because boot logs
  // are tee'd to disk by `utils/file-logger.ts` and a printed secret is a
  // persisted secret. Only the email defaults (administrator@local).
  initialAdmin: z.object({
    email: z.string().email().optional(),
    password: z.string().optional(),
  }),

  // Platform S3 (conversation attachment storage — optional, attachments not persisted if missing)
  platformS3: z.object({
    bucket: z.string(),
    region: z.string(),
    accessKeyId: z.string(),
    secretAccessKey: z.string(),
  }).optional(),

  // Inbound message coordinator (WhatsApp/Telegram). Collapses burst fragments
  // and cancels in-flight pipelines when a new fragment arrives.
  //   softDebounceMs: sliding coalescing window before the pipeline fires
  //   typingDelayMs: delay before sending the channel's typing indicator
  //   maxRestarts: cap on consecutive cancel-and-restart cycles per conversation
  coordinator: z.object({
    softDebounceMs: z.coerce.number().int().min(0).default(2000),
    typingDelayMs: z.coerce.number().int().min(0).default(1500),
    maxRestarts: z.coerce.number().int().min(0).default(3),
  }),

  // PDF rendering (markdownToPdf tool). `concurrency` caps how many puppeteer
  // pages render in parallel inside the singleton Chromium browser. Each page
  // costs ~50-100MB RSS during render, so the default is conservative — bump
  // up in environments with more RAM, down on tight container memory.
  pdf: z.object({
    concurrency: z.coerce.number().int().min(1).max(32).default(3),
  }),

  // Agent-to-agent invocation (virtual `agent` channel).
  //   callTimeoutMs: maximum wall-clock duration of a single sub-agent call.
  //     On timeout the synthesised tool returns an error string to the caller.
  agent: z.object({
    callTimeoutMs: z.coerce.number().int().positive().default(60000),
  }),

  // Activity stream (SSE) resource limits.
  //   maxConnections:    global cap on concurrent SSE subscribers (across all users).
  //   maxPerUser:        per-authenticated-user cap on concurrent SSE subscribers.
  // Excess connections are rejected with HTTP 503 + Retry-After.
  activityStream: z.object({
    maxConnections: z.coerce.number().int().positive().default(50),
    maxPerUser: z.coerce.number().int().positive().default(5),
  }),

  // Knowledge ingestion resource limits.
  //   maxDocsPerInstance: hard cap on the number of knowledge documents an
  //     instance may hold. Uploads beyond the cap are rejected with 400.
  knowledge: z.object({
    maxDocsPerInstance: z.coerce.number().int().positive().default(500),
  }),

  // Analytics retention. Daily housekeeping deletes rows older than
  // `retentionDays` from `ai_logs` and `pipeline_traces` so the tables don't
  // grow unboundedly. Default 90 days.
  analytics: z.object({
    retentionDays: z.coerce.number().int().positive().default(90),
  }),

  // Plugin roots. `dirs` are absolute paths (from PLUGIN_DIRS, comma-separated)
  // the tool loader scans for external plugins in addition to the convention
  // dir (src/plugins/*). Primarily local dev / explicit override.
  plugins: z.object({
    dirs: z.array(z.string()).default([]),
  }),

  // External MCP (Model Context Protocol) client servers (instance-configured,
  // consumed via @ai-sdk/mcp).
  //   connectTimeoutMs: bounds the per-server createMCPClient()+tools() round
  //     trip so one hung/slow server can't stall every turn. On expiry the
  //     server is treated exactly like a dead server (log warn + skip).
  mcp: z.object({
    connectTimeoutMs: z.coerce.number().int().positive().default(10000),
  }),
}));

export type Config = z.infer<typeof configSchema>;

/** Parse individual components from DATABASE_URL when individual POSTGRES_* vars are missing. */
function parseDatabaseUrl(): { user: string; password: string; host: string; port: string; database: string } | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return {
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      host: parsed.hostname,
      port: parsed.port || "5432",
      database: parsed.pathname.replace(/^\//, ""),
    };
  } catch {
    return null;
  }
}

function buildDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const user = process.env.POSTGRES_USER ?? "polyant";
  const password = process.env.POSTGRES_PASSWORD ?? "";
  const host = process.env.POSTGRES_HOST ?? "localhost";
  const port = process.env.POSTGRES_PORT ?? "5432";
  const database = process.env.POSTGRES_DB ?? "polyant";
  return `postgresql://${user}:${password}@${host}:${port}/${database}`;
}

function loadConfig(): Config {
  const dbUrlParsed = parseDatabaseUrl();
  const result = configSchema.safeParse({
    postgres: {
      host: process.env.POSTGRES_HOST ?? dbUrlParsed?.host,
      port: process.env.POSTGRES_PORT ?? dbUrlParsed?.port,
      database: process.env.POSTGRES_DB ?? dbUrlParsed?.database,
      user: process.env.POSTGRES_USER ?? dbUrlParsed?.user,
      password: process.env.POSTGRES_PASSWORD ?? dbUrlParsed?.password,
      databaseUrl: buildDatabaseUrl(),
      ssl: process.env.POSTGRES_SSL,
    },
    memory: {
      dedupSimilarityThreshold: process.env.DEDUP_SIMILARITY_THRESHOLD,
    },
    server: {
      port: process.env.API_PORT,
      baseUrl: process.env.BASE_URL,
      trustProxy: process.env.TRUST_PROXY,
      throttle: {
        enabled: process.env.THROTTLE_ENABLED,
        ttlMs: process.env.THROTTLE_TTL_MS,
        limit: process.env.THROTTLE_LIMIT,
      },
    },
    encryption: {
      key: process.env.ENCRYPTION_KEY,
    },
    datetime: {
      timezone: process.env.DATETIME_TIMEZONE,
      locale: process.env.DATETIME_LOCALE,
    },
    auth: {
      secret: process.env.AUTH_SECRET,
      internalSecret: process.env.AUTH_INTERNAL_SECRET,
      mode: process.env.AUTH_MODE,
      platformAdminEmail: process.env.PLATFORM_ADMIN_EMAIL,
    },
    initialAdmin: {
      email: process.env.INITIAL_ADMIN_EMAIL,
      password: process.env.INITIAL_ADMIN_PASSWORD,
    },
    platformS3: process.env.PLATFORM_S3_BUCKET ? {
      bucket: process.env.PLATFORM_S3_BUCKET,
      region: process.env.PLATFORM_S3_REGION,
      accessKeyId: process.env.PLATFORM_S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.PLATFORM_S3_SECRET_ACCESS_KEY,
    } : undefined,
    coordinator: {
      softDebounceMs: process.env.MESSAGE_SOFT_DEBOUNCE_MS,
      typingDelayMs: process.env.MESSAGE_TYPING_DELAY_MS,
      maxRestarts: process.env.MESSAGE_MAX_RESTARTS,
    },
    pdf: {
      concurrency: process.env.PDF_CONCURRENCY,
    },
    agent: {
      callTimeoutMs: process.env.AGENT_CALL_TIMEOUT_MS,
    },
    activityStream: {
      maxConnections: process.env.SSE_MAX_CONNECTIONS,
      maxPerUser: process.env.SSE_MAX_CONNECTIONS_PER_USER,
    },
    knowledge: {
      maxDocsPerInstance: process.env.KNOWLEDGE_MAX_DOCS_PER_INSTANCE,
    },
    analytics: {
      retentionDays: process.env.ANALYTICS_RETENTION_DAYS,
    },
    plugins: {
      // CONVENTION-EXCEPTION: PLUGIN_DIRS is parsed here (split + trim) into the
      // Zod schema; the raw comma-separated string never leaks past config.
      dirs: (process.env.PLUGIN_DIRS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    },
    mcp: {
      connectTimeoutMs: process.env.MCP_CONNECT_TIMEOUT_MS,
    },
  });

  if (!result.success) {
    console.error("Configuration error:", result.error.format());
    process.exit(1);
  }

  // Checked here rather than as a schema refinement so `auth.mode` keeps its full
  // union type: the gateway branch in `auth/auth.guard.ts` is dormant, not deleted,
  // and narrowing the type to "session" would make it unreachable code the compiler
  // rejects — leaving the eventual fix with nothing to switch back on.
  if (result.data.auth.mode === "alb-oidc") {
    console.error(
      "Configuration error: AUTH_MODE=alb-oidc is not supported in this release. " +
        "Since RBAC became unconditional, a gateway-forwarded principal resolves no organization " +
        "and is denied on every management route — the panel would load and 403 on every call. " +
        "Use AUTH_MODE=session (see docs/UPGRADING.md).",
    );
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();

/** Default instance for mono-instance system. Override via DEFAULT_INSTANCE_ID env var. */
// CONVENTION-EXCEPTION: reads process.env directly — documented exception in CLAUDE.md (DEFAULT_INSTANCE_ID).
export const DEFAULT_INSTANCE_ID = asInstanceSlug(process.env.DEFAULT_INSTANCE_ID ?? "default");
