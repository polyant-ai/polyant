#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Browser measurements of panel pages against the production web build behind
// an ALB-like proxy, signed in as a synthetic user via a minted session cookie.
// Per page, cold (fresh context) and warm (client-side navigation back to it):
//   ttfb, fcp, lcp           browser paint timings
//   ready_ms                 navigation start -> no request in flight for 1s (the
//                            activity stream excluded), scripts included: a page
//                            waiting on a large chunk is not ready
//   api_calls / api_dupes    /api requests fired, and how many repeat a URL
//   js_kb / js_files         JavaScript transferred (compressed) on a cold load
// Usage: node fe-measure.mjs [runs]
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(new URL("../../../packages/web/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const BASE = process.env.BASE ?? "http://localhost:4480";
const RUNS = Number(process.argv[2] ?? 3);
const sessions = JSON.parse(readFileSync(new URL("../.work/sessions.json", import.meta.url)));
const cookieOf = (email) => sessions.find((s) => s.email === email).cookie.split("=").slice(1).join("=");
// The small-organization persona: perf-org-50 at full scale, the last one
// present otherwise.
const smallOrg = sessions.some((s) => s.org === "perf-org-50") ? "perf-org-50"
  : sessions.map((s) => s.org).filter((o) => o && o !== "perf-org-1").sort().at(-1);

const bigWs = "/organizations/perf-org-1/workspaces/perf-ws-1";
const smallWs = `/organizations/${smallOrg}/workspaces/perf-ws-1`;
const pages = [
  ["big", "perf-u1@perf-org-1.local", "root_redirect", "/"],
  ["big", "perf-u1@perf-org-1.local", "dashboard", bigWs],
  ["big", "perf-u1@perf-org-1.local", "conversations", `${bigWs}/conversations`],
  ["big", "perf-u1@perf-org-1.local", "conversation_long", `${bigWs}/conversations/perf-c-long?instanceId=perf-perf-org-1-perf-ws-1-a1`],
  ["big", "perf-u1@perf-org-1.local", "agents", `${bigWs}/instances`],
  ["big", "perf-u1@perf-org-1.local", "agent_detail", `${bigWs}/instances/perf-perf-org-1-perf-ws-1-a1`],
  ["big", "perf-u1@perf-org-1.local", "org_overview", "/organizations/perf-org-1/settings/organization/overview"],
  ["small", `perf-u1@${smallOrg}.local`, "dashboard", smallWs],
  ["small", `perf-u1@${smallOrg}.local`, "conversations", `${smallWs}/conversations`],
  ["platform", "perf-platform@perf.local", "platform_analytics", "/platform/analytics"],
];

const paintScript = () => {
  window.__lcp = 0;
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lcp = e.startTime; })
    .observe({ type: "largest-contentful-paint", buffered: true });
};

async function measure(browser, email, path) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: "authjs.session-token", value: cookieOf(email), url: BASE }]);
  await ctx.addInitScript(paintScript);
  const page = await ctx.newPage();
  const inflight = new Set();
  const api = [];
  let jsBytes = 0, jsFiles = 0, status429 = 0;
  let lastApi = Date.now();
  const isApi = (u) => u.includes("/api/") && !u.includes("/api/activity-stream") && !u.includes("/api/auth/");
  const tracked = (u) => !u.includes("/api/activity-stream") && !u.startsWith("data:");
  page.on("request", (r) => {
    if (tracked(r.url())) inflight.add(r);
    if (isApi(r.url())) api.push(new URL(r.url()).pathname);
  });
  const done = (r) => { if (inflight.delete(r)) lastApi = Date.now(); };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  page.on("response", async (res) => {
    if (res.status() === 429) status429++;
    if (res.request().resourceType() === "script") {
      jsFiles++;
      try { jsBytes += (await res.request().sizes()).responseBodySize; } catch {}
    }
  });
  const t0 = Date.now();
  await page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 120000 });
  // Ready: at least one /api call happened and nothing in flight for 1s.
  while (Date.now() - t0 < 120000) {
    await page.waitForTimeout(100);
    if (api.length > 0 && inflight.size === 0 && Date.now() - lastApi > 1000) break;
  }
  const ready = lastApi - t0;
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0];
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    return { ttfb: n?.responseStart ?? 0, fcp: fcp?.startTime ?? 0, lcp: window.__lcp };
  });
  const dupes = api.length - new Set(api).size;
  await ctx.close();
  return { ...nav, ready_ms: ready, api_calls: api.length, api_dupes: dupes, js_kb: Math.round(jsBytes / 1024), js_files: jsFiles, status429 };
}

const browser = await chromium.launch();
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
console.log(["persona", "page", "ttfb", "fcp", "lcp", "ready_ms", "api_calls", "api_dupes", "js_kb", "js_files", "429s"].join("\t"));
for (const [persona, email, name, path] of pages) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push(await measure(browser, email, path));
  const m = (k) => Math.round(med(runs.map((r) => r[k])));
  console.log([persona, name, m("ttfb"), m("fcp"), m("lcp"), m("ready_ms"), m("api_calls"), m("api_dupes"), m("js_kb"), m("js_files"), Math.max(...runs.map((r) => r.status429))].join("\t"));
}
await browser.close();
