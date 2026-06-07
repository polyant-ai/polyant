// SPDX-License-Identifier: AGPL-3.0-or-later

import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { INestApplication, LogLevel } from "@nestjs/common";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { ServerModule } from "./server.module.js";
import { OpenAIService } from "./openai/openai.service.js";
import { GlobalExceptionFilter } from "./filters/http-exception.filter.js";
import { config } from "../config.js";
import type { MessageHandler, StreamMessageHandler } from "../channels/types.js";

export function getCorsOptions(env: NodeJS.ProcessEnv = process.env): {
  origin: boolean | string[];
  credentials: boolean;
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
    };
  }

  if (env.NODE_ENV === "production") {
    return {
      origin: false,
      credentials: false,
    };
  }

  // Development: restrict to localhost only — `origin: true` mirrors any Origin header back,
  // allowing credentialed cross-origin requests from arbitrary sites on the local network.
  return {
    origin: ["http://localhost:3000", "http://localhost:3001", "http://127.0.0.1:3000", "http://127.0.0.1:3001"],
    credentials: true,
  };
}

/**
 * NestJS log levels: production keeps the quiet error/warn/log subset this
 * server has always used (NestJS's own default would include debug/verbose);
 * every non-production NODE_ENV (development, test, unset) also gets
 * debug/verbose so framework internals (router, DI, guards) are visible.
 * Same testable env-param pattern as getCorsOptions above.
 */
export function getLogLevels(env: NodeJS.ProcessEnv = process.env): LogLevel[] {
  return env.NODE_ENV === "production"
    ? ["error", "warn", "log"]
    : ["error", "warn", "log", "debug", "verbose"];
}

export async function startServer(
  messageHandler: MessageHandler,
  streamMessageHandler: StreamMessageHandler,
): Promise<INestApplication> {
  const app = await NestFactory.create(ServerModule, { logger: getLogLevels() });

  // Express `trust proxy`: when unset (default 0) we ignore X-Forwarded-* so
  // attackers can't spoof Host/Proto to bypass the Twilio HMAC. Operators
  // behind a reverse proxy must opt in explicitly via TRUST_PROXY.
  const httpAdapter = app.getHttpAdapter();
  const instance = httpAdapter.getInstance() as { set?: (k: string, v: unknown) => void };
  instance.set?.("trust proxy", config.server.trustProxy);

  // Security headers
  app.use(helmet());

  // Cookie parser for session token extraction from Auth.js cookies
  app.use(cookieParser());

  // Global exception filter for standardized error responses
  app.useGlobalFilters(new GlobalExceptionFilter());

  // Inject the message handlers into OpenAI service
  const openaiService = app.get(OpenAIService);
  openaiService.setMessageHandler(messageHandler);
  openaiService.setStreamMessageHandler(streamMessageHandler);

  // CORS: in production we fail closed unless an explicit allowlist is configured.
  app.enableCors(getCorsOptions());

  const port = config.server.port;
  await app.listen(port);
  console.log(`HTTP server listening on port ${port}`);

  return app;
}
