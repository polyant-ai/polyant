#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Per-stage table of a ramping k6 run, joined with the resource sampler.
// Each stage is a 10s ramp followed by a hold of <stage seconds>; only the
// hold window is reported. Metrics whose name contains "failed" are rates and
// print as a percentage. --by <tag> splits every metric by a custom tag (e.g.
// org, which panel.js sets to big or small).
// Usage: summarize-stages.mjs <label> <stages csv> <stage seconds> [--by <tag>] <metric> [<metric> ...]
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const args = process.argv.slice(2);
const byIdx = args.indexOf("--by");
const by = byIdx >= 0 ? args.splice(byIdx, 2)[1] : null;
const [label, stagesCsv, holdS, ...metrics] = args;
if (!label || !stagesCsv || !holdS || metrics.length === 0) {
  console.error("usage: summarize-stages.mjs <label> <stages csv> <stage seconds> [--by <tag>] <metric> [<metric> ...]");
  process.exit(1);
}
const dir = new URL(`./.work/results/${label}/`, import.meta.url);
const stages = stagesCsv.split(",").map(Number);
const hold = Number(holdS);

const lines = gunzipSync(readFileSync(new URL("k6.csv.gz", dir))).toString().trim().split("\n");
const header = lines.shift().split(",");
const col = (n) => header.indexOf(n);
const [iName, iTime, iValue, iExtra] = [col("metric_name"), col("timestamp"), col("metric_value"), col("extra_tags")];
const series = new Map();
let t0 = Infinity;
for (const line of lines) {
  const f = line.split(",");
  const t = Number(f[iTime]);
  if (t < t0) t0 = t;
  if (!metrics.includes(f[iName])) continue;
  const tag = by ? (f[iExtra]?.match(new RegExp(`${by}=([^&]+)`))?.[1] ?? "-") : "";
  const key = by ? `${f[iName]}[${tag}]` : f[iName];
  if (!series.has(key)) series.set(key, []);
  series.get(key).push([t, Number(f[iValue])]);
}

const sampler = readFileSync(new URL("sampler.csv", dir), "utf8").trim().split("\n");
const sHead = sampler.shift().split(",");
const samples = sampler.map((l) => Object.fromEntries(l.split(",").map((v, i) => [sHead[i], Number(v)])))
  .filter((r) => Number.isFinite(r.t));

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN; };
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const keys = [...series.keys()].sort();

const head = ["vus"];
for (const k of keys) head.push(...(k.includes("failed") ? [`${k}:%`] : [`${k}:n`, `${k}:p50`, `${k}:p95`, `${k}:p99`]));
head.push("eng_cpu%avg", "eng_mem_max", "pg_cpu%avg", "pg_active_max", "pg_lockwait_max", "health_ms_p95");
const rows = [head];
stages.forEach((v, i) => {
  const a = t0 + i * (10 + hold) + 10, b = a + hold;
  const row = [String(v)];
  for (const k of keys) {
    const vals = series.get(k).filter(([t]) => t >= a && t < b).map(([, x]) => x);
    if (k.includes("failed")) row.push(vals.length ? (100 * mean(vals)).toFixed(1) : "-");
    else row.push(String(vals.length), ...[0.5, 0.95, 0.99].map((p) => (vals.length ? pct(vals, p).toFixed(0) : "-")));
  }
  const s = samples.filter((r) => r.t >= a && r.t < b);
  if (s.length) {
    row.push(mean(s.map((r) => r.engine_cpu)).toFixed(0), Math.max(...s.map((r) => r.engine_mem_mib)).toFixed(0),
      mean(s.map((r) => r.pg_cpu)).toFixed(0), String(Math.max(...s.map((r) => r.pg_active))),
      String(Math.max(...s.map((r) => r.pg_lock_wait))), pct(s.map((r) => r.health_ms), 0.95).toFixed(0));
  }
  rows.push(row);
});
const widths = head.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
for (const r of rows) console.log(r.map((x, c) => (x ?? "").padEnd(widths[c])).join("  "));
