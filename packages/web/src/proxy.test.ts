// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment node

/**
 * The proxy matcher decides which requests the web session gate sees at all.
 * A path it misses is served without a session check; a path it catches by
 * mistake breaks a caller that authenticates elsewhere (the engine API behind
 * the rewrites, `/v1` with agent API keys) or every static asset.
 *
 * Matched with Next's own matcher implementation, so the test reads the
 * pattern the way the server does. That helper patches Node's module loader
 * and cannot load inside the test runner's VM context, so it runs in a child
 * Node process; the matcher itself is read from `proxy.ts`.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config } from "./proxy";

// The session gate itself is irrelevant here; only `config` is under test.
vi.mock("next-auth", () => ({ default: () => ({ auth: vi.fn() }) }));
vi.mock("@/lib/auth.config", () => ({ authConfig: {} }));

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));

const MATCH_SCRIPT = `
const { unstable_doesMiddlewareMatch } = require("next/experimental/testing/server");
const { matcher, paths } = JSON.parse(process.argv[1]);
const result = paths.map((path) =>
  unstable_doesMiddlewareMatch({ config: { matcher }, url: "http://panel.test" + path }),
);
process.stdout.write(JSON.stringify(result));
`;

const GATED = [
  "/",
  // The gate sends a signed-in user away from these two, so it must see them.
  "/login",
  "/password-change",
  "/settings",
  "/organizations/acme/members",
  "/organizations/acme/workspaces/sales/instances/bot",
  // A tenant or agent slug that happens to read "api" or "v1" is still a page.
  "/organizations/api/workspaces/v1/conversations",
  // The engine's health check is rewritten here too, but only `/api/health`
  // is meant to be reachable without a session.
  "/health",
];

const UNGATED = [
  "/api/instances",
  "/api/organizations/acme/members",
  "/api/health",
  "/v1/chat/completions",
  "/_next/static/chunks/main.js",
  "/_next/image",
  "/favicon.ico",
  "/brand/logo.svg",
];

function matchAll(paths: string[]): Map<string, boolean> {
  const out = execFileSync(
    process.execPath,
    ["-e", MATCH_SCRIPT, JSON.stringify({ matcher: config.matcher, paths })],
    { cwd: WEB_ROOT, encoding: "utf8" },
  );
  const results = JSON.parse(out) as boolean[];
  return new Map(paths.map((path, i) => [path, results[i]]));
}

const matched = matchAll([...GATED, ...UNGATED]);

function gated(path: string): boolean | undefined {
  return matched.get(path);
}

describe("proxy matcher", () => {
  it.each(GATED)("puts the page %s behind the session gate", (path) => {
    expect(gated(path)).toBe(true);
  });

  it.each(UNGATED)("leaves %s to its own authentication", (path) => {
    expect(gated(path)).toBe(false);
  });
});
