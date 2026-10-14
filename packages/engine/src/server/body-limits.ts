// SPDX-License-Identifier: AGPL-3.0-or-later

import { json, type NextFunction, type Request, type Response } from "express";
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
 * Parse POST requests on the routes above with the larger limit. Must be
 * called before the app initialises (listen), so it runs ahead of Nest's
 * default JSON parser, which leaves an already-parsed request alone; call it
 * after enableCors so a refused body still carries the CORS headers.
 *
 * Mounted as an Express route (exact path and method) rather than with
 * `app.use`, which matches path prefixes and every method. It stays a
 * separate middleware instead of `app.useBodyParser("json", { limit })`
 * because that would raise the limit on every route, public webhooks included.
 * Nest's default parser stays registered, so other routes keep `req.body` and
 * `req.rawBody`.
 */
export function allowLargeJsonBodies(
  app: INestApplication,
  routes: readonly string[] = LARGE_JSON_BODY_ROUTES,
): void {
  const parse = json({ limit: LARGE_JSON_BODY_LIMIT_BYTES });
  const express = app.getHttpAdapter().getInstance() as {
    post: (paths: string[], handler: (req: Request, res: Response, next: NextFunction) => void) => void;
  };
  express.post([...routes], (req, res, next) => parse(req, res, next));
}
