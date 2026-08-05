// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Single source of truth for the RBAC E2E harness environment.
 *
 * Everything that the Playwright config, the DB-prepare step, the seed and the
 * specs need to agree on (ports, URLs, the test database name, the shared
 * secrets, the seeded user credentials) lives here — no magic strings scattered
 * across files (coding-style.md: "No magic strings").
 *
 * The harness runs the engine + web against a DEDICATED test database
 * (`polyant_e2e`) on the SAME PostgreSQL server the dev stack already uses
 * (docker compose). Only the database is integration-tested; no external
 * service (AI provider, channels) is exercised by the members/RBAC flow, so
 * none is configured — they stay inert (mocking-by-omission).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Resolve the monorepo root by walking up from the current working directory
 * until we find the workspace root (a package.json next to `packages/engine`).
 * Deliberately avoids `import.meta.url` / `__dirname`: Playwright loads this
 * file through a CommonJS loader (the web package is not `type: module`) where
 * `import.meta` is a syntax error, while tsx runs it as ESM where `__dirname`
 * is undefined — a cwd-walk works under both.
 */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "packages", "engine"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("Could not locate monorepo root (no package.json + packages/engine found).");
    }
    dir = parent;
  }
}

export const REPO_ROOT = findRepoRoot();
export const WEB_PACKAGE_ROOT = resolve(REPO_ROOT, "packages", "web");

/** Dedicated ports so the harness never collides with a running dev stack. */
export const ENGINE_PORT = 4100;
export const WEB_PORT = 3100;
export const ENGINE_URL = `http://127.0.0.1:${ENGINE_PORT}`;
export const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

/** Isolated test database — never the dev `polyant` database. */
export const TEST_DB_NAME = "polyant_e2e";

/**
 * Test-only secrets. These are NOT real credentials and only ever protect the
 * throwaway test database — committing them is intentional and safe.
 * `AUTH_SECRET` must be identical in web + engine (engine decrypts the JWE).
 */
export const AUTH_SECRET = "polyant-e2e-auth-secret-at-least-32-characters-long";
export const AUTH_INTERNAL_SECRET = "polyant-e2e-internal-credentials-verify-secret";
/** 32-byte key as 64 hex chars (AES-256-GCM). */
export const ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/** The three OSS privilege-ladder roles under test. */
export const RBAC_ROLE_KEYS = ["owner", "member", "viewer"] as const;
export type RbacRoleKey = (typeof RBAC_ROLE_KEYS)[number];

export interface RbacTestUser {
  readonly key: RbacRoleKey;
  readonly email: string;
  readonly name: string;
  readonly password: string;
  readonly roleKey: RbacRoleKey;
}

/** Seeded users — one per role, all in the default org. Passwords ≥ 8 chars. */
export const RBAC_TEST_USERS: readonly RbacTestUser[] = [
  { key: "owner", email: "owner@e2e.polyant.test", name: "E2E Owner", password: "e2e-owner-password", roleKey: "owner" },
  { key: "member", email: "member@e2e.polyant.test", name: "E2E Member", password: "e2e-member-password", roleKey: "member" },
  { key: "viewer", email: "viewer@e2e.polyant.test", name: "E2E Viewer", password: "e2e-viewer-password", roleKey: "viewer" },
];

export function getTestUser(key: RbacRoleKey): RbacTestUser {
  const user = RBAC_TEST_USERS.find((u) => u.key === key);
  if (!user) throw new Error(`No RBAC test user for role "${key}"`);
  return user;
}

/**
 * PostgreSQL connection parts. Read from the repo-root `.env` (the dev stack's
 * source of truth for `POSTGRES_PASSWORD` etc.) so the harness never hardcodes
 * the password. Falls back to docker-compose defaults.
 */
interface PgParts {
  readonly user: string;
  readonly password: string;
  readonly host: string;
  readonly port: string;
}

function parseRootEnv(): Record<string, string> {
  try {
    const raw = readFileSync(resolve(REPO_ROOT, ".env"), "utf8");
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function pgParts(): PgParts {
  const env = parseRootEnv();
  const pick = (k: string, fallback: string) => process.env[k] ?? env[k] ?? fallback;
  return {
    user: pick("POSTGRES_USER", "polyant"),
    password: pick("POSTGRES_PASSWORD", "polyant"),
    host: pick("POSTGRES_HOST", "localhost"),
    port: pick("POSTGRES_PORT", "5432"),
  };
}

function buildUrl(database: string): string {
  const { user, password, host, port } = pgParts();
  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

/** Connection to the test database itself. */
export const TEST_DATABASE_URL = buildUrl(TEST_DB_NAME);
/** Connection to the maintenance `postgres` database (to CREATE the test DB). */
export const ADMIN_DATABASE_URL = buildUrl("postgres");

/** process.env with `undefined` values dropped (Playwright wants string-only). */
function definedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/**
 * Environment for the engine child process: test DB, dedicated port, shared
 * secrets, and crucially `AUTHZ_ENFORCE=true` — without it the PermissionGuard
 * runs in shadow mode and every would-be 403 silently passes, making RBAC
 * assertions meaningless.
 */
export function buildEngineEnv(): Record<string, string> {
  return {
    ...definedEnv(),
    DATABASE_URL: TEST_DATABASE_URL,
    POSTGRES_DB: TEST_DB_NAME,
    API_PORT: String(ENGINE_PORT),
    AUTH_SECRET,
    AUTH_INTERNAL_SECRET,
    ENCRYPTION_KEY,
    AUTHZ_ENFORCE: "true",
    LOG_LEVEL: "warn",
  };
}

/** Environment for the web (Next.js) child process. */
export function buildWebEnv(): Record<string, string> {
  return {
    ...definedEnv(),
    DATABASE_URL: TEST_DATABASE_URL,
    AUTH_SECRET,
    AUTH_INTERNAL_SECRET,
    AUTH_TRUST_HOST: "true",
    AUTH_URL: WEB_URL,
    // Browser-facing API base (inlined at build, used by next.config rewrites).
    NEXT_PUBLIC_API_URL: ENGINE_URL,
    // Server-side engine base used by the credentials-verify fetch in
    // auth.config.ts. MUST point at the test engine — otherwise it falls back to
    // .env.local's localhost:4000 (the dev engine) and login fails.
    INTERNAL_ENGINE_URL: ENGINE_URL,
    // Isolated build dir so a production build+start coexists with a running
    // `next dev` (which holds `.next`) without clobbering it.
    NEXT_DIST_DIR: ".next-e2e",
  };
}
