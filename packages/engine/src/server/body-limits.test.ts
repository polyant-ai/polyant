// SPDX-License-Identifier: AGPL-3.0-or-later

import "reflect-metadata";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Body, Controller, Module, Param, Post, Req, type INestApplication, type RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { NestFactory } from "@nestjs/core";
import { allowLargeJsonBodies, LARGE_JSON_BODY_ROUTES } from "./body-limits.js";

// Same paths as the real routes, so the matching is what is under test.
@Controller("api/instances")
class BundleRoutes {
  @Post("import") importNew(@Body() b: { s: string }) { return { n: b.s.length }; }
  @Post(":slug/import") importOver(@Param("slug") _s: string, @Body() b: { s: string }) { return { n: b.s.length }; }
  @Post(":slug/knowledge") upload(@Param("slug") _s: string, @Body() b: { s: string }) { return { n: b.s.length }; }
  @Post(":slug/knowledge/import") importKnowledge(@Param("slug") _s: string, @Body() b: { s: string }) { return { n: b.s.length }; }
  @Post(":slug/memories") other(@Param("slug") _s: string, @Body() b: { s: string }) { return { n: b.s.length }; }
}

// Stands in for a signed webhook: the signature is checked over `req.rawBody`.
@Controller("api/webhooks")
class WebhookRoute {
  @Post("signed") signed(@Req() req: RawBodyRequest<Request>, @Body() b: { s: string }) {
    return { s: b.s, raw: req.rawBody?.toString("utf8") ?? null };
  }
}

@Module({ controllers: [BundleRoutes, WebhookRoute] })
class TestModule {}

let app: INestApplication;
let base: string;

beforeAll(async () => {
  // As in main.ts: rawBody on, Nest's own parsers at their defaults.
  app = await NestFactory.create(TestModule, { logger: false, rawBody: true });
  allowLargeJsonBodies(app);
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
});

const twoMegabytes = JSON.stringify({ s: "x".repeat(2 * 1024 * 1024) });
const post = (path: string, body: string) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body });

describe("JSON body limits", () => {
  // A knowledge document may be 5 MB and a bundle carries many of them, but
  // Nest's default JSON parser refuses anything above 100 KB with a 413 before
  // the handler's own size check runs.
  it.each([
    "/api/instances/import",
    "/api/instances/support-bot/import",
    "/api/instances/support-bot/knowledge",
    "/api/instances/support-bot/knowledge/import",
  ])("accepts a 2 MB body on %s", async (path) => {
    const res = await post(path, twoMegabytes);
    expect(res.status).toBe(201);
  });

  // The same 2 MB body is refused by the default parser, which is what every
  // route above met before it was listed.
  it("keeps the default limit everywhere else", async () => {
    const res = await post("/api/instances/support-bot/memories", twoMegabytes);
    expect(res.status).toBe(413);
  });

  // The large parser must not stand in for Nest's own: Nest skips registering
  // its JSON parser when it finds one with the same function name, which left
  // every other route — login included — with an empty body.
  it("still parses JSON on every other route", async () => {
    const res = await post("/api/instances/support-bot/memories", JSON.stringify({ s: "abc" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ n: 3 });
  });

  it("keeps the raw body that webhook signatures are checked against", async () => {
    const body = JSON.stringify({ s: "signed" });
    const res = await post("/api/webhooks/signed", body);
    expect(await res.json()).toEqual({ s: "signed", raw: body });
  });

  it("names every route it raises, so a new bundle route is added on purpose", () => {
    expect(LARGE_JSON_BODY_ROUTES).toEqual([
      "/api/instances/import",
      "/api/instances/:slug/import",
      "/api/instances/:slug/knowledge",
      "/api/instances/:slug/knowledge/import",
    ]);
  });
});
