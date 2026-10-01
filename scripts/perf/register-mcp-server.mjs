#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Registers the fake MCP server ("orders") on every agent of a .work agents
// file, or disables it with --disable. The engine refuses private hosts for
// MCP when NODE_ENV=production, so an MCP test runs the engine with
// NODE_ENV=development (and its control run in the same mode).
// Usage: node register-mcp-server.mjs <agents file in .work> [--disable]
import { readFileSync } from "node:fs";

const [file, flag] = process.argv.slice(2);
if (!file || (flag && flag !== "--disable")) {
  console.error("usage: register-mcp-server.mjs <agents file in .work> [--disable]");
  process.exit(1);
}
const work = new URL("./.work/", import.meta.url);
const base = `http://localhost:${process.env.ENGINE_PORT ?? 4400}`;
const mcpUrl = `http://host.docker.internal:${process.env.FAKE_MCP_PORT ?? 7171}/mcp`;
const sessions = JSON.parse(readFileSync(new URL("sessions.json", work), "utf8"));
const rows = readFileSync(new URL(file, work), "utf8").trim().split("\n").map((l) => l.split("|"));

let ok = 0;
for (const [slug, org, ws] of rows) {
  const admin = sessions.find((s) => s.email === `perf-u1@${org}.local`);
  const r = await fetch(`${base}/api/instances/${slug}/mcp-servers/orders`, {
    method: "PUT",
    headers: { cookie: admin.cookie, "content-type": "application/json", "X-Org-Slug": org, "X-Workspace-Slug": ws },
    body: JSON.stringify({ name: "Orders", url: mcpUrl, authMode: "none", enabled: flag !== "--disable", config: {} }),
  });
  if (r.ok) ok++;
  else console.error(slug, r.status, (await r.text()).slice(0, 200));
}
console.log(`MCP server ${flag ? "disabled" : "registered"} on ${ok} of ${rows.length} agents`);
if (ok !== rows.length) process.exit(1);
