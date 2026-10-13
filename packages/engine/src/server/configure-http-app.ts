// SPDX-License-Identifier: AGPL-3.0-or-later

import type { INestApplication, LogLevel } from "@nestjs/common";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { GlobalExceptionFilter } from "./filters/http-exception.filter.js";
import { allowLargeJsonBodies } from "./body-limits.js";
import { config } from "../config.js";

/** Response headers browser clients may read: `x-should-retry` tells OpenAI SDKs not to retry a 503 that retrying cannot fix. */
const EXPOSED_HEADERS = ["x-should-retry"];

/**
 * NestJS log levels: production keeps the quiet error/warn/log subset this
 * server has always used (NestJS's own default would include debug/verbose);
 * every non-production NODE_ENV (development, test, unset) also gets
 * debug/verbose so framework internals (router, DI, guards) are visible.
 * Same testable env-param pattern as getCorsOptions, and kept beside it so a
 * test of either does not import the whole server module graph.
 */
export function getLogLevels(env: NodeJS.ProcessEnv = process.env): LogLevel[] {
  return env.NODE_ENV === "production"
    ? ["error", "warn", "log"]
    : ["error", "warn", "log", "debug", "verbose"];
}

export function getCorsOptions(env: NodeJS.ProcessEnv = process.env): {
  origin: boolean | string[];
  credentials: boolean;
  exposedHeaders: string[];
} {
  const corsOrigins = env.CORS_ORIGINS
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (corsOrigins && corsOrigins.length > 0) {
    // A credentialed wildcard is never safe: it would let any origin read
    // authenticated responses. Fail fast at startup rather than silently
    // accept it.
    if (corsOrigins.includes("*")) {
      throw new Error(
        "CORS_ORIGINS=* is not allowed; list explicit origins or unset",
      );
    }
    return {
      origin: corsOrigins,
      credentials: true,
      exposedHeaders: EXPOSED_HEADERS,
    };
  }

  if (env.NODE_ENV === "production") {
    return {
      origin: false,
      credentials: false,
      exposedHeaders: EXPOSED_HEADERS,
    };
  }

  // Development: restrict to localhost only — `origin: true` mirrors any Origin header back,
  // allowing credentialed cross-origin requests from arbitrary sites on the local network.
  return {
    origin: ["http://localhost:3000", "http://localhost:3001", "http://127.0.0.1:3000", "http://127.0.0.1:3001"],
    credentials: true,
    exposedHeaders: EXPOSED_HEADERS,
  };
}

/**
 * Middleware, CORS and error handling shared by the real server and its tests.
 * Order matters: CORS comes before any body parsing so that a refused body
 * (413) still carries the CORS headers the browser needs to read it.
 */
export function configureHttpApp(app: INestApplication): void {
  // Express `trust proxy`: governs Express's OWN `req.protocol`/`req.hostname`/
  // `req.ip` getters — used by rate limiting and anything else that reads
  // those. It does NOT protect the Twilio HMAC input: `getFullUrl` in
  // twilio-webhook.controller.ts reads `x-forwarded-proto`/`x-forwarded-host`
  // straight from `req.headers`, bypassing this setting entirely in either
  // direction (set or unset). That input is instead hardened at the source —
  // the forwarded scheme is clamped to http/https and a mismatched signature
  // simply fails closed. Operators behind a reverse proxy still need
  // TRUST_PROXY for the Express-level getters above to reflect it.
  const httpAdapter = app.getHttpAdapter();
  const instance = httpAdapter.getInstance() as { set?: (k: string, v: unknown) => void };
  instance.set?.("trust proxy", config.server.trustProxy);

  // Security headers
  app.use(helmet());

  // Cookie parser for session token extraction from Auth.js cookies
  app.use(cookieParser());

  // CORS: in production we fail closed unless an explicit allowlist is configured.
  app.enableCors(getCorsOptions());

  // Document and bundle uploads exceed the default 100 KB JSON limit.
  allowLargeJsonBodies(app);

  // Global exception filter for standardized error responses
  app.useGlobalFilters(new GlobalExceptionFilter());
}
