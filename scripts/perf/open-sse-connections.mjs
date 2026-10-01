#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Opens N activity-stream SSE connections (one per organization admin in
// turn, the way N browser tabs would), holds them HOLD_S seconds, and reports
// how many the engine accepted, what the rest got, and how many events
// arrived. Admins, because workspace-bound members reach the stream only where
// workspace-scoped permissions exist. Past one connection per admin, the
// per-user cap (sse_max_connections_per_user) applies too.
// Usage: node open-sse-connections.mjs <N> [HOLD_S]
import http from "node:http";
import { readFileSync } from "node:fs";

const N = Number(process.argv[2] ?? 100);
const HOLD = Number(process.argv[3] ?? 30) * 1000;
const sessions = JSON.parse(readFileSync(new URL("./.work/sessions.json", import.meta.url))).filter((s) => s.org && s.email.startsWith("perf-u1@"));
const statuses = {};
let events = 0;
let bytes = 0;
const reqs = [];

for (let i = 0; i < N; i++) {
  const s = sessions[i % sessions.length];
  const req = http.get({
    host: "localhost", port: Number(process.env.ENGINE_PORT ?? 4400), path: "/api/activity-stream/live", agent: false,
    headers: { Cookie: s.cookie, "X-Org-Slug": s.org, Accept: "text/event-stream" },
  }, (res) => {
    statuses[res.statusCode] = (statuses[res.statusCode] ?? 0) + 1;
    res.on("data", (c) => { bytes += c.length; events += (String(c).match(/\n\n/g) ?? []).length; });
    res.on("error", () => {});
  });
  req.on("error", (e) => { statuses[e.code] = (statuses[e.code] ?? 0) + 1; });
  reqs.push(req);
}

setTimeout(() => {
  console.log(JSON.stringify({ requested: N, statuses, events, bytes }));
  for (const r of reqs) r.destroy();
  setTimeout(() => process.exit(0), 500);
}, HOLD);
