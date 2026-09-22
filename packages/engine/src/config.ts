// SPDX-License-Identifier: AGPL-3.0-or-later

import dotenv from "dotenv";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";

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
 * value: `Number("")` is `0`, so `THROTTLE_TTL_MS=` meant a zero-length window,
 * and an empty string where a URL was expected made its parser throw.
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

  // HTTP Server (NestJS)
  server: z.object({
    port: z.coerce.number().default(4000),
    /**
     * Public origin of the engine, as the DEPLOYMENT declares it: `BASE_URL`
     * when set, otherwise `http://localhost:<port>` from the transform below, so
     * consumers read a string and never a fallback.
     *
     * It is the BOOTSTRAP value, not the last word. `platform_settings.base_url`
     * wins where an administrator has set one, which is how a wrong public URL
     * is corrected without a redeploy — see `platform-settings.store.ts`, the
     * one place the two are combined. Nothing outside that resolver should read
     * this field. The four callers that build a public URL from
     * it (webhook callbacks, the two OAuth redirect builders, the A2A agent card)
     * each used to write that fallback themselves — four chances to disagree
     * about what an unset BASE_URL means.
     */
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
    // Per-IP rate limiting (@nestjs/throttler): whether it runs at all. The
    // WINDOW and the LIMIT are platform settings, edited in the panel; this
    // switch is not, because it exists for parallel dev/eval runs that would
    // otherwise trip the limits from a single IP, and because a limiter that can
    // be turned off from inside the product is no use to a locked-out
    // administrator. THROTTLE_ENABLED=false disables ALL throttling, the global
    // default and every per-route @Throttle override alike. Only the literal
    // "false" disables (z.coerce.boolean() would treat "false" as true).
    throttle: z.object({
      enabled: z
        .string()
        .optional()
        .transform((v) => v !== "false"),
    }),
  }).transform((server) => ({
    ...server,
    baseUrl: server.baseUrl ?? `http://localhost:${server.port}`,
  })),

  // Encryption (AES-256-GCM requires a 32-byte key = 64 hex characters)
  encryption: z.object({
    key: z.string().regex(
      /^[0-9a-fA-F]{64}$/,
      "ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes for AES-256-GCM)",
    ),
  }),

  // Auth (Auth.js JWT decryption + credentials provider)
  auth: z.object({
    secret: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
    /** Shared secret between web and engine for the internal credentials endpoint.
     *  When unset, /api/auth/credentials/verify is disabled (only Google login works). */
    internalSecret: z.string().min(16).optional(),
    /** RBAC: the user with this email is promoted to Platform Admin on boot by
     *  the OrganizationsModule bootstrap. It sets `is_platform_admin = true` and
     *  nothing else — that flag is the sole authority for platform-admin
     *  standing, read from the database on every request, and the panel renders
     *  the account from the same flag. Idempotent; unset = no promotion
     *  (migration 0076 reconciles any pre-existing platform-admin user before
     *  the old `users.role` column is dropped). */
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


  // Plugin roots. `dirs` are absolute paths (from PLUGIN_DIRS, comma-separated)
  // the tool loader scans for external plugins in addition to the convention
  // dir (src/plugins/*). Primarily local dev / explicit override.
  plugins: z.object({
    dirs: z.array(z.string()).default([]),
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

/**
 * Assemble the connection string from whichever form the deployment provides.
 * Both are first-class: `DATABASE_URL` is what a managed provider hands you,
 * while the individual `POSTGRES_*` are what a deployment gets — the CDK wires
 * each one from a separate field of the Aurora secret and cannot read a secret's
 * value at synth time to build a URL.
 *
 * The credentials are percent-encoded, which `parseDatabaseUrl` above already
 * assumed by decoding them. Interpolated raw, a password containing `@`, `/` or
 * `:` produced a URL that parses as a different host.
 */
export function buildDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  const user = encodeURIComponent(env.POSTGRES_USER ?? "polyant");
  const password = encodeURIComponent(env.POSTGRES_PASSWORD ?? "");
  const host = env.POSTGRES_HOST ?? "localhost";
  const port = env.POSTGRES_PORT ?? "5432";
  const database = env.POSTGRES_DB ?? "polyant";
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
    server: {
      port: process.env.API_PORT,
      baseUrl: process.env.BASE_URL,
      trustProxy: process.env.TRUST_PROXY,
      throttle: {
        enabled: process.env.THROTTLE_ENABLED,
      },
    },
    encryption: {
      key: process.env.ENCRYPTION_KEY,
    },
    auth: {
      secret: process.env.AUTH_SECRET,
      internalSecret: process.env.AUTH_INTERNAL_SECRET,
    },
    initialAdmin: {
      email: process.env.INITIAL_ADMIN_EMAIL,
      password: process.env.INITIAL_ADMIN_PASSWORD,
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
