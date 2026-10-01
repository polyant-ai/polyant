// SPDX-License-Identifier: AGPL-3.0-or-later
// Single-user latency of the panel's data endpoints on a high-volume dataset.
// One VU walks every endpoint ITER times as three personas: the admin of the
// large organization, the admin of a small one, and the platform admin.
// A 404 means the endpoint is absent from this edition: it is reported once
// and kept out of both the latencies and the error count.
import http from "k6/http";
import { Trend, Counter } from "k6/metrics";

const BASE = __ENV.BASE ?? "http://host.docker.internal:4400";
const ITER = Number(__ENV.ITER ?? 5);
const sessions = JSON.parse(open("../.work/sessions.json"));
const cookieOf = (email) => sessions.find((s) => s.email === email).cookie;
// The small-organization persona: perf-org-50 at full scale, the last one
// present otherwise.
const smallOrg = sessions.some((s) => s.org === "perf-org-50") ? "perf-org-50"
  : sessions.map((s) => s.org).filter((o) => o && o !== "perf-org-1").sort().at(-1);

const to = new Date();
const from30 = new Date(to - 30 * 864e5).toISOString();
const from90 = new Date(to - 90 * 864e5).toISOString();
const toIso = to.toISOString();

const personas = [
  { name: "big", email: "perf-u1@perf-org-1.local", org: "perf-org-1", ws: "perf-ws-1", agent: "perf-perf-org-1-perf-ws-1-a1", conv: "perf-c-b30" },
  { name: "small", email: `perf-u1@${smallOrg}.local`, org: smallOrg, ws: "perf-ws-1", agent: null, conv: null },
];

const endpoints = (p) => [
  ["me", "/api/me"],
  ["me_access", "/api/me/access"],
  ["instances", "/api/instances"],
  ["agent_checks", "/api/analytics/agent-checks"],
  ["analytics_ws_30d", `/api/analytics?from=${from30}&to=${toIso}`],
  ["analytics_ws_90d", `/api/analytics?from=${from90}&to=${toIso}`],
  ["org_analytics_30d", `/api/organizations/${p.org}/analytics?from=${from30}&to=${toIso}`],
  ["org_ws_breakdown_30d", `/api/organizations/${p.org}/analytics/workspaces?from=${from30}&to=${toIso}`],
  ["conv_list_p1", "/api/conversations?limit=20"],
  ["conv_list_p50", "/api/conversations?limit=20&offset=1000"],
  ["conv_list_search", "/api/conversations?limit=20&search=fattura"],
  ["conv_list_sort_cost", "/api/conversations?limit=20&sort=totalCost&dir=desc"],
  ["audit_list", "/api/audit-logs?limit=30"],
  ["audit_stats", "/api/audit-logs/stats"],
  ["authz_audit", `/api/organizations/${p.org}/authz-audit-logs?limit=30`],
  ["mgmt_audit", `/api/organizations/${p.org}/management-audit-logs?limit=30`],
  ...(p.conv ? [
    ["conv_detail", `/api/conversations/${p.conv}?instanceId=${p.agent}`],
    ["conv_messages", `/api/conversations/${p.conv}/messages?instanceId=${p.agent}&limit=50`],
    ["conv_long_detail", `/api/conversations/perf-c-long?instanceId=${p.agent}`],
    ["conv_long_messages", `/api/conversations/perf-c-long/messages?instanceId=${p.agent}&limit=50`],
    ["agent_analytics_30d", `/api/instances/${p.agent}/analytics?from=${from30}&to=${toIso}`],
  ] : []),
];

const errors = new Counter("endpoint_errors");
const platformList = [
  ["me", "/api/me"],
  ["platform_analytics_30d", `/api/platform/analytics?from=${from30}&to=${toIso}`],
];
const plan = personas.map((p) => ({ p, list: endpoints(p) }));
plan.push({ p: { name: "platform", email: "perf-platform@perf.local" }, list: platformList });
// k6 accepts custom metrics only in the init context.
const trends = {};
for (const { p, list } of plan) for (const [name] of list) trends[`${p.name}_${name}`] = new Trend(`ep_${p.name}_${name}`, true);
const trend = (name) => trends[name];

export const options = { vus: 1, iterations: 1, summaryTrendStats: ["min", "med", "p(95)", "max"] };

export default function () {
  for (let i = 0; i < ITER; i++) {
    for (const { p, list } of plan) {
      const headers = { Cookie: cookieOf(p.email), ...(p.org ? { "X-Org-Slug": p.org, "X-Workspace-Slug": p.ws } : {}) };
      for (const [name, path] of list) {
        const r = http.get(`${BASE}${path}`, { headers, timeout: "60s", tags: { ep: name, persona: p.name } });
        if (r.status === 404) {
          if (i === 0) console.warn(`${p.name} ${name} -> absent in this edition`);
          continue;
        }
        trend(`${p.name}_${name}`).add(r.timings.duration);
        if (r.status !== 200) {
          errors.add(1, { ep: name, persona: p.name });
          if (i === 0) console.warn(`${p.name} ${name} -> ${r.status} ${String(r.body).slice(0, 120)}`);
        }
      }
    }
  }
}
