// SPDX-License-Identifier: AGPL-3.0-or-later

import { json } from "express";
import type { INestApplication } from "@nestjs/common";

/**
 * Routes whose JSON body is a document or a bundle of documents.
 *
 * Nest's JSON parser keeps body-parser's 100 KB default, which is right for
 * every other route (public webhooks included) and wrong here: a knowledge
 * document may be 5 MB, and an agent or knowledge bundle carries many of them.
 * Without this the handler's own size check never ran — the parser answered
 * 413 first.
 */
export const LARGE_JSON_BODY_ROUTES: readonly string[] = [
  "/api/instances/import",
  "/api/instances/:slug/import",
  "/api/instances/:slug/knowledge",
  "/api/instances/:slug/knowledge/import",
];

/** Upper bound for one bundle. The handlers still enforce their per-document limits. */
export const LARGE_JSON_BODY_LIMIT_BYTES = 50 * 1024 * 1024;

/**
 * Parse the routes above with the larger limit. Must run before the first
 * request: body-parser marks a parsed request, so Nest's default JSON parser,
 * registered later, leaves it alone.
 */
export function allowLargeJsonBodies(
  app: INestApplication,
  routes: readonly string[] = LARGE_JSON_BODY_ROUTES,
): void {
  app.use([...routes], json({ limit: LARGE_JSON_BODY_LIMIT_BYTES }));
}
