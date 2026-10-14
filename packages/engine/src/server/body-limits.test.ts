// SPDX-License-Identifier: AGPL-3.0-or-later

import "reflect-metadata";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Body, Controller, Get, Module, Param, Post, Req, type INestApplication, type RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { NestFactory } from "@nestjs/core";
import { LARGE_JSON_BODY_ROUTES } from "./body-limits.js";
import { configureHttpApp } from "./configure-http-app.js";

// Same paths as the real routes, so the matching is what is under test.
@Controller("api/instances")
class BundleRoutes {
  @Post("import") importNew(@Body() b: { s: string }) { return { n: b.s.length }; }
  @Post(":slug/import") importOver(@Param("slug") _s: string, @Body() b: { s: string }) { return { n: b.s.length }; }
  @Post(":slug/knowledge") upload(@Param("slug") _s: string, @Body() b: { s: string }) { return { n: b.s.length }; }
  @Post(":slug/knowledge/import") importKnowledge(@Param("slug") _s: string, @Body() b: { s: string }) { return { n: b.s.length }; }
  @Get(":slug/knowledge/:docId") read(@Param("slug") _s: string) { return { ok: true }; }
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
  // Same bootstrap as the real server: rawBody on, then the shared middleware,
  // CORS and global exception filter, in main.ts's order.
  app = await NestFactory.create(TestModule, { logger: false, rawBody: true });
  configureHttpApp(app);
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

  it("answers 413 with the parser's message, not 500, on a normal route", async () => {
    const res = await post("/api/webhooks/signed", JSON.stringify({ s: "x".repeat(200 * 1024) }));
    expect(res.status).toBe(413);
    expect(((await res.json()) as { message: string }).message).toMatch(/too large/i);
  });

  it("answers 413 above 50 MB on a large route", async () => {
    const res = await post("/api/instances/support-bot/knowledge", JSON.stringify({ s: "x".repeat(51 * 1024 * 1024) }));
    expect(res.status).toBe(413);
  });

  it("answers 415 for an unsupported charset", async () => {
    const res = await fetch(base + "/api/webhooks/signed", {
      method: "POST",
      headers: { "content-type": "application/json; charset=nonsense" },
      body: "{}",
    });
    expect(res.status).toBe(415);
  });

  // Only POST on the four exact routes gets the 50 MB limit.
  it("does not raise the limit for other methods or sub-paths", async () => {
    // A 2 MB POST on a sub-path meets the default limit (413 before routing).
    const res = await post("/api/instances/support-bot/knowledge/doc-1", twoMegabytes);
    expect(res.status).toBe(413);
    const get = await fetch(base + "/api/instances/support-bot/knowledge/doc-1", {
      method: "GET",
      headers: { "content-type": "application/json" },
    });
    expect(get.status).toBe(200);
  });

  it("keeps CORS headers on a refused body", async () => {
    const res = await fetch(base + "/api/instances/support-bot/memories", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: twoMegabytes,
    });
    expect(res.status).toBe(413);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    const large = await fetch(base + "/api/instances/support-bot/knowledge", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ s: "x".repeat(51 * 1024 * 1024) }),
    });
    expect(large.status).toBe(413);
    expect(large.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
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
