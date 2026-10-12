// SPDX-License-Identifier: AGPL-3.0-or-later

import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { INestApplication, LogLevel } from "@nestjs/common";
import { ServerModule } from "./server.module.js";
import { OpenAIService } from "./openai/openai.service.js";
import { A2aHandlerRegistry } from "./a2a/a2a-handler.registry.js";
import { configureHttpApp } from "./configure-http-app.js";

export { getCorsOptions } from "./configure-http-app.js";
import { config } from "../config.js";
import type { MessageHandler, StreamMessageHandler } from "../channels/types.js";

/**
 * NestJS log levels: production keeps the quiet error/warn/log subset this
 * server has always used (NestJS's own default would include debug/verbose);
 * every non-production NODE_ENV (development, test, unset) also gets
 * debug/verbose so framework internals (router, DI, guards) are visible.
 * Same testable env-param pattern as getCorsOptions.
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
  const app = await NestFactory.create(ServerModule, { logger: getLogLevels(), rawBody: true });

  configureHttpApp(app);

  // Inject the message handlers into OpenAI service
  const openaiService = app.get(OpenAIService);
  openaiService.setMessageHandler(messageHandler);
  openaiService.setStreamMessageHandler(streamMessageHandler);

  // Inject the stream message handler into the A2A registry (same pattern as OpenAIService)
  const a2aRegistry = app.get(A2aHandlerRegistry);
  a2aRegistry.setStreamMessageHandler(streamMessageHandler);

  const port = config.server.port;
  await app.listen(port);
  console.log(`HTTP server listening on port ${port}`);

  return app;
}
