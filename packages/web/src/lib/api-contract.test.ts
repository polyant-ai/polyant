// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment node

/**
 * Every request the panel's API client can send must reach a route the engine
 * mounts, through a rewrite the Next.js server forwards.
 *
 * A typo in a path, a route renamed on one side only, or a new engine route
 * without its rewrite line all fail the same way in production: a 404 the
 * user sees as a broken screen. Hand-written per-endpoint tests could only pin
 * the string the client already sends, so they agreed with the bug.
 *
 * Both sides are DISCOVERED here, never listed by hand:
 * - the client side by calling every function on `api` with placeholder
 *   arguments and recording the request it issues;
 * - the engine side by reading the route decorators of every controller under
 *   `packages/engine/src`.
 *
 * A path segment that came from an argument may only match a `:param` segment,
 * and a literal segment only the same literal. Without that rule a misspelt
 * literal (`/api/instances/modlz`) would pass by matching `/api/instances/:slug`.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import nextConfig from "../../next.config";
import { api } from "./api";

const ENGINE_SRC = fileURLToPath(new URL("../../../engine/src", import.meta.url));

const PLACEHOLDER = /^arg\d+$/;

interface EngineRoute {
  readonly method: string;
  readonly path: string;
  readonly segments: readonly string[];
}

interface ClientCall {
  readonly name: string;
  readonly method: string;
  readonly path: string;
}

const ROUTE_DECORATOR = /@(Controller|Get|Post|Put|Patch|Delete)\(\s*(?:"([^"]*)")?\s*\)/g;

function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** Every `@Controller` + `@Get/@Post/...` pair in the engine's controller files. */
function discoverEngineRoutes(): EngineRoute[] {
  const files = readdirSync(ENGINE_SRC, { recursive: true, encoding: "utf8" }).filter(
    (file) => file.endsWith(".controller.ts"),
  );
  const routes: EngineRoute[] = [];
  for (const file of files) {
    const source = readFileSync(join(ENGINE_SRC, file), "utf8");
    let base = "";
    for (const [, decorator, arg = ""] of source.matchAll(ROUTE_DECORATOR)) {
      if (decorator === "Controller") {
        base = arg;
        continue;
      }
      const segments = splitPath(`${base}/${arg}`);
      routes.push({ method: decorator.toUpperCase(), path: `/${segments.join("/")}`, segments });
    }
  }
  return routes;
}

type AnyFn = (...args: unknown[]) => unknown;

function collectFunctions(node: object, prefix: string): [string, AnyFn][] {
  return Object.entries(node).flatMap(([key, value]): [string, AnyFn][] => {
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "function") return [[name, value as AnyFn]];
    if (value && typeof value === "object") return collectFunctions(value, name);
    return [];
  });
}

/**
 * Calls every `api` function with `arg0, arg1, ...` and records what it sends.
 * A function that returns a path instead of fetching (an SSE URL for
 * `EventSource`) is recorded as the GET it will become.
 */
async function discoverClientCalls(): Promise<{ calls: ClientCall[]; silent: string[] }> {
  const calls: ClientCall[] = [];
  const silent: string[] = [];
  for (const [name, fn] of collectFunctions(api, "")) {
    const seen: { url: string; method: string }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), method: init?.method ?? "GET" });
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const args = Array.from({ length: Math.max(fn.length, 1) }, (_, i) => `arg${i}`);
    const result = await Promise.resolve(fn(...args)).catch(() => undefined);
    if (typeof result === "string" && result.startsWith("/")) {
      seen.push({ url: result, method: "GET" });
    }
    if (seen.length === 0) silent.push(name);
    for (const { url, method } of seen) {
      calls.push({ name, method, path: new URL(url, "http://panel.test").pathname });
    }
  }
  return { calls, silent };
}

function matchesRoute(call: ClientCall, route: EngineRoute): boolean {
  if (call.method !== route.method) return false;
  const actual = splitPath(call.path);
  for (let i = 0; i < route.segments.length; i++) {
    const expected = route.segments[i];
    // Express 5 named wildcard (`*key`): one or more remaining segments.
    if (expected.startsWith("*")) return actual.length > i;
    const segment = actual[i];
    if (segment === undefined) return false;
    if (expected.startsWith(":")) {
      if (!PLACEHOLDER.test(segment)) return false;
    } else if (segment !== expected) {
      return false;
    }
  }
  return actual.length === route.segments.length;
}

/** Next.js rewrite sources as matchers (`:path*` is zero or more segments). */
async function forwardedPrefixes(): Promise<RegExp[]> {
  const rewrites = await nextConfig.rewrites!();
  const list = Array.isArray(rewrites)
    ? rewrites
    : [...(rewrites.beforeFiles ?? []), ...(rewrites.afterFiles ?? []), ...(rewrites.fallback ?? [])];
  return list.map(({ source }) => {
    const pattern = source.replace(/\/:[a-zA-Z]+\*$/, "(?:/.*)?").replace(/:[a-zA-Z]+/g, "[^/]+");
    return new RegExp(`^${pattern}$`);
  });
}

describe("API client ↔ engine route contract", () => {
  const engineRoutes = discoverEngineRoutes();
  let client: Awaited<ReturnType<typeof discoverClientCalls>>;

  beforeAll(async () => {
    client = await discoverClientCalls();
  });

  it("discovers the engine routes and the client calls it compares", () => {
    // Non-vacuity: a broken walk on either side would make the checks below
    // pass on an empty set. The floors are far under the real counts.
    expect(engineRoutes.length).toBeGreaterThan(100);
    expect(client.calls.length).toBeGreaterThan(100);
  });

  it("exercises every function on the API client", () => {
    // A function that sends nothing could hide a path from this guardrail.
    expect(client.silent).toEqual([]);
  });

  it("sends every request to a route the engine mounts", () => {
    const unmatched = client.calls
      .filter((call) => !engineRoutes.some((route) => matchesRoute(call, route)))
      .map(({ name, method, path }) => `${name}: ${method} ${path}`);

    expect(unmatched).toEqual([]);
  });

  it("sends every request through a path the Next.js server forwards to the engine", async () => {
    const forwarded = await forwardedPrefixes();
    const unforwarded = client.calls
      .filter(({ path }) => !forwarded.some((re) => re.test(path)))
      .map(({ name, path }) => `${name}: ${path}`);

    expect(unforwarded).toEqual([]);
  });
});
