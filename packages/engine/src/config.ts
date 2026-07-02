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

const configSchema = z.object({
  // Database
  postgres: z.object({
    host: z.string().default("localhost"),
    port: z.coerce.number().default(5432),
    database: z.string().default("polyant"),
    user: z.string().default("polyant"),
    password: z.string(),
    databaseUrl: z.string(),
    ssl: z.coerce.boolean().default(false),
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
    timezone: z.string().default("UTC"),
    locale: z.string().default("en-US"),
  }),

  // Auth (Auth.js JWT decryption + credentials provider)
  auth: z.object({
    secret: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
    /** Shared secret between web and engine for the internal credentials endpoint.
     *  When unset, /api/auth/credentials/verify is disabled (only Google login works). */
    internalSecret: z.string().min(16).optional(),
    /** Auth source: "session" (Auth.js JWT) or "alb-oidc" (trust ALB x-amzn-oidc-data header).
     *  Use "alb-oidc" when deployed behind an AWS ALB with OIDC authentication — the ALB
     *  has already authenticated the user, so the engine trusts the forwarded claims. */
    mode: z.enum(["session", "alb-oidc"]).default("session"),
    /** RBAC: the user with this email is promoted to Platform Superadmin
     *  (is_platform_admin=true) by the OrganizationsModule bootstrap on boot.
     *  Idempotent; unset = no promotion (the migration already promotes
     *  pre-existing role='superadmin' users). */
    platformAdminEmail: z.string().email().optional(),
  }),

  // RBAC authorization (Stream 3). Ships in SHADOW mode by default: the
  // PermissionGuard resolves scope and logs decisions but never denies unless
  // `enforce` is true. Flip `AUTHZ_ENFORCE=true` to fail-closed on undeclared
  // routes and denied permissions. Any value other than the literal "true"
  // (including unset and "false") keeps shadow mode — no behaviour change.
  authz: z.object({
    enforce: z
      .enum(["true", "false"])
      .default("false")
      .transform((v): boolean => v === "true"),
  }),

  // Initial admin user — created on first boot if the users table is empty.
  // Both fields optional: defaults are administrator@local + a random password
  // logged once at first boot.
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
});

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
    authz: {
      enforce: process.env.AUTHZ_ENFORCE,
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
  });

  if (!result.success) {
    console.error("Configuration error:", result.error.format());
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();

/** Default instance for mono-instance system. Override via DEFAULT_INSTANCE_ID env var. */
// CONVENTION-EXCEPTION: reads process.env directly — documented exception in CLAUDE.md (DEFAULT_INSTANCE_ID).
export const DEFAULT_INSTANCE_ID = asInstanceSlug(process.env.DEFAULT_INSTANCE_ID ?? "default");
