// SPDX-License-Identifier: AGPL-3.0-or-later
// Concurrent conversations: each VU is one end user holding a three-turn
// conversation with one of the keyed agents, through the streaming chat
// endpoint. The fake model takes MODEL_MS per answer, so
// `platform_overhead` = turn duration - MODEL_MS is what the platform adds.
import http from "k6/http";
import { sleep, check } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";

const BASE = __ENV.BASE ?? "http://host.docker.internal:4400";
const MODEL_MS = Number(__ENV.MODEL_MS ?? 2000);
const STAGES = (__ENV.STAGES ?? "10,25,50,100,200,400").split(",").map(Number);
const STAGE_S = Number(__ENV.STAGE_S ?? 60);
const agents = open(`../.work/${__ENV.AGENTS ?? "agents.tsv"}`).trim().split("\n").map((l) => l.split("|")[0]);

const turn = new Trend("turn_ms", true);
const overhead = new Trend("platform_overhead_ms", true);
const ttfb = new Trend("turn_ttfb_ms", true);
const failed = new Rate("turn_failed");
const fallback = new Counter("turn_unavailable");
const kbFound = new Trend("kb_found");
const toolEvents = new Counter("tool_results");

export const options = {
  scenarios: {
    chat: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: STAGES.flatMap((v) => [{ duration: "10s", target: v }, { duration: `${STAGE_S}s`, target: v }]),
      gracefulRampDown: "30s",
    },
  },
  summaryTrendStats: ["med", "p(90)", "p(95)", "p(99)", "max"],
};

export default function () {
  const agent = agents[Math.floor(Math.random() * agents.length)];
  const chatId = `perf-load-${__VU}-${__ITER}-${Date.now()}`;
  const messages = [];
  for (let i = 0; i < 3; i++) {
    messages.push({ role: "user", content: `Domanda ${i + 1}: vorrei informazioni sul mio ordine` });
    const r = http.post(`${BASE}/api/instances/${agent}/chat/stream`,
      JSON.stringify({ model: "agent", messages, chat_id: chatId, stream: true }),
      { headers: { "content-type": "application/json" }, timeout: "120s", tags: { name: "chat_stream" } });
    const body = String(r.body ?? "");
    const ok = (r.status === 200 || r.status === 201) && body.includes("event: done") && !body.includes("event: error");
    const unavailable = body.includes("not available right now");
    if (unavailable) fallback.add(1);
    failed.add(!ok || unavailable);
    check(r, { "turn ok": () => ok && !unavailable });
    for (const m of body.matchAll(/\\?"found\\?":(\d+)/g)) kbFound.add(Number(m[1]));
    toolEvents.add((body.match(/event: tool-result/g) ?? []).length);
    if (ok && !unavailable) {
      turn.add(r.timings.duration, { vus: String(__VU <= 0 ? 0 : currentStage()) });
      overhead.add(Math.max(0, r.timings.duration - MODEL_MS), { vus: String(currentStage()) });
      ttfb.add(r.timings.waiting);
    }
    messages.push({ role: "assistant", content: "Risposta" });
    sleep(2 + Math.random() * 2);
  }
}

// Which stage target the run is in, by elapsed time, for per-stage breakdowns.
const started = Date.now();
function currentStage() {
  const s = (Date.now() - started) / 1000;
  const i = Math.min(STAGES.length - 1, Math.floor(s / (STAGE_S + 10)));
  return STAGES[i];
}
