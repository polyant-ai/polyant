#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Gives each agent in a .work/<agents file> a model key through the engine's
// own API, as the organization's admin, so the agent can call the fake model.
// The key is never checked by the fake; it only has to be present.
// Usage: node set-agent-keys.mjs <agents file in .work>
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: set-agent-keys.mjs <agents file in .work, e.g. agents-100.tsv>");
  process.exit(1);
}
const work = new URL("./.work/", import.meta.url);
const base = `http://localhost:${process.env.ENGINE_PORT ?? 4400}`;
const sessions = JSON.parse(readFileSync(new URL("sessions.json", work), "utf8"));
const rows = readFileSync(new URL(file, work), "utf8").trim().split("\n").map((l) => l.split("|"));

let ok = 0;
for (const [slug, org, ws] of rows) {
  const admin = sessions.find((s) => s.email === `perf-u1@${org}.local`);
  const r = await fetch(`${base}/api/instances/${slug}/secrets`, {
    method: "PUT",
    headers: { cookie: admin.cookie, "content-type": "application/json", "X-Org-Slug": org, "X-Workspace-Slug": ws },
    body: JSON.stringify({ secrets: [{ key: "openai_api_key", value: "fake-key-for-load-tests" }] }),
  });
  if (r.ok) ok++;
  else console.error(slug, r.status, (await r.text()).slice(0, 150));
}
console.log(`model key set on ${ok} of ${rows.length} agents`);
if (ok !== rows.length) process.exit(1);
