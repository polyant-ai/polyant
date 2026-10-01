// SPDX-License-Identifier: AGPL-3.0-or-later
// Concurrent panel users. Each VU is a real synthetic user (20% from the large
// organization) who opens the workspace dashboard, then the conversation list,
// then the agent list, with reading pauses in between. Each "page" fires the
// requests the web app fires for it, in parallel like the browser does.
import http from "k6/http";
import { sleep } from "k6";
import { Trend, Rate } from "k6/metrics";

const BASE = __ENV.BASE ?? "http://host.docker.internal:4400";
const STAGES = (__ENV.STAGES ?? "10,25,50,100,200").split(",").map(Number);
const STAGE_S = Number(__ENV.STAGE_S ?? 60);
const THINK = Number(__ENV.THINK_S ?? 5);
const sessions = JSON.parse(open("../.work/sessions.json")).filter((s) => s.org);
const big = sessions.filter((s) => s.org === "perf-org-1");
const small = sessions.filter((s) => s.org !== "perf-org-1");

const page = {
  dashboard: new Trend("page_dashboard_ms", true),
  conversations: new Trend("page_conversations_ms", true),
  agents: new Trend("page_agents_ms", true),
};
const failed = new Rate("req_failed");

export const options = {
  scenarios: {
    panel: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: STAGES.flatMap((v) => [{ duration: "10s", target: v }, { duration: `${STAGE_S}s`, target: v }]),
      gracefulRampDown: "30s",
    },
  },
  summaryTrendStats: ["med", "p(90)", "p(95)", "p(99)", "max"],
};

function user() {
  const pool = Math.random() < 0.2 ? big : small;
  const s = pool[(__VU * 7919) % pool.length];
  // Members are bound to workspace ((n-2) % 3) + 1; admins see all, use ws-1.
  const n = Number(s.email.match(/perf-u(\d+)@/)[1]);
  const ws = n === 1 ? "perf-ws-1" : `perf-ws-${((n - 2) % 3) + 1}`;
  return { headers: { Cookie: s.cookie, "X-Org-Slug": s.org, "X-Workspace-Slug": ws }, isBig: s.org === "perf-org-1" };
}

function load(name, paths, u) {
  const t = Date.now();
  const res = http.batch(paths.map((p) => ["GET", `${BASE}${p}`, null, { headers: u.headers, timeout: "60s", tags: { page: name } }]));
  for (const r of res) failed.add(r.status >= 400 || r.status === 0, { page: name });
  page[name].add(Date.now() - t, { org: u.isBig ? "big" : "small" });
}

export default function () {
  const u = user();
  const to = new Date().toISOString();
  const from = new Date(Date.now() - 30 * 864e5).toISOString();
  load("dashboard", ["/api/me", "/api/me/access", "/api/analytics/agent-checks", `/api/analytics?from=${from}&to=${to}`], u);
  sleep(THINK * (0.5 + Math.random()));
  load("conversations", ["/api/me/access", "/api/conversations?limit=20", "/api/instances"], u);
  sleep(THINK * (0.5 + Math.random()));
  load("agents", ["/api/me/access", "/api/instances", "/api/analytics/agent-checks"], u);
  sleep(THINK * (0.5 + Math.random()));
}
