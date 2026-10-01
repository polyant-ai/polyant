#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Summary mobile check of panel pages: Pixel 7 emulation, 4x CPU slowdown and
// a slow-4G network (150 ms RTT, 1.6 Mbps down, 750 kbps up), cold load.
// Per page: fcp, lcp, ready_ms (no request in flight for 1s, the activity
// stream excluded, scripts included), page width vs
// viewport (horizontal overflow) and how many elements stick out; a
// screenshot per page lands in results/mobile/.
import { createRequire } from "node:module";
import { readFileSync, mkdirSync } from "node:fs";

const require = createRequire(new URL("../../../packages/web/package.json", import.meta.url));
const { chromium, devices } = require("@playwright/test");
const BASE = process.env.BASE ?? "http://localhost:4480";
const OUT = new URL("../.work/results/mobile/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const sessions = JSON.parse(readFileSync(new URL("../.work/sessions.json", import.meta.url)));
const cookieOf = (email) => sessions.find((s) => s.email === email).cookie.split("=").slice(1).join("=");
// The small-organization persona: perf-org-50 at full scale, the last one
// present otherwise.
const smallOrg = sessions.some((s) => s.org === "perf-org-50") ? "perf-org-50"
  : sessions.map((s) => s.org).filter((o) => o && o !== "perf-org-1").sort().at(-1);

const ws = "/organizations/perf-org-1/workspaces/perf-ws-1";
const pages = [
  ["login", null, "/login"],
  ["dashboard", "perf-u1@perf-org-1.local", ws],
  ["conversations", "perf-u1@perf-org-1.local", `${ws}/conversations`],
  ["conversation", "perf-u1@perf-org-1.local", `${ws}/conversations/perf-c-b30?instanceId=perf-perf-org-1-perf-ws-1-a1`],
  ["agents", "perf-u1@perf-org-1.local", `${ws}/instances`],
  ["agent_detail", "perf-u1@perf-org-1.local", `${ws}/instances/perf-perf-org-1-perf-ws-1-a1`],
  ["small_dashboard", `perf-u1@${smallOrg}.local`, `/organizations/${smallOrg}/workspaces/perf-ws-1`],
];

const browser = await chromium.launch();
console.log(["page", "fcp", "lcp", "ready_ms", "page_w", "view_w", "overflowing_elems"].join("\t"));
for (const [name, email, path] of pages) {
  const ctx = await browser.newContext({ ...devices["Pixel 7"] });
  if (email) await ctx.addCookies([{ name: "authjs.session-token", value: cookieOf(email), url: BASE }]);
  await ctx.addInitScript(() => {
    window.__lcp = 0;
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lcp = e.startTime; })
      .observe({ type: "largest-contentful-paint", buffered: true });
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 });
  const inflight = new Set(); let calls = 0; let last = Date.now();
  const isApi = (u) => u.includes("/api/") && !u.includes("activity-stream") && !u.includes("/api/auth/");
  const tracked = (u) => !u.includes("activity-stream") && !u.startsWith("data:");
  page.on("request", (r) => { if (tracked(r.url())) inflight.add(r); if (isApi(r.url())) calls++; });
  const done = (r) => { if (inflight.delete(r)) last = Date.now(); };
  page.on("requestfinished", done); page.on("requestfailed", done);
  const t0 = Date.now();
  await page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 180000 });
  while (Date.now() - t0 < 180000) {
    await page.waitForTimeout(200);
    if ((calls > 0 || !email) && inflight.size === 0 && Date.now() - last > 1000) break;
  }
  const m = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    let over = 0;
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + 1) over++;
    }
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    return { fcp: fcp?.startTime ?? 0, lcp: window.__lcp, pw: document.documentElement.scrollWidth, vw, over };
  });
  await page.screenshot({ path: `${OUT}${name}.png` });
  console.log([name, Math.round(m.fcp), Math.round(m.lcp), email ? last - t0 : "-", m.pw, m.vw, m.over].join("\t"));
  await ctx.close();
}
await browser.close();
