#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Summarises a V8 .cpuprofile (from `--cpu-prof`): self time by package and
// by function, so the cost of a whole library (web streams, the ORM, the GC)
// is visible at a glance and not spread over hundreds of frames.
// Usage: summarize-cpu-profile.mjs <file.cpuprofile> [top N]
import { readFileSync } from "node:fs";

const [file, topArg] = process.argv.slice(2);
if (!file) {
  console.error("usage: summarize-cpu-profile.mjs <file.cpuprofile> [top N]");
  process.exit(1);
}
const TOP = Number(topArg ?? 30);
const p = JSON.parse(readFileSync(file, "utf8"));
const nodes = new Map(p.nodes.map((n) => [n.id, n]));
const self = new Map();
p.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (p.timeDeltas[i + 1] ?? 0) / 1000));

function pkg(url, fn) {
  if (!url) return `(${fn || "native"})`;
  const mod = url.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if (mod) return mod[1];
  const dist = url.match(/\/dist\/(.+?)\/[^/]+\.js/);
  if (dist) return `engine:${dist[1]}`;
  return url.startsWith("node:") ? url : url.slice(-60);
}

const byPkg = new Map(), byFn = new Map();
let total = 0, idle = 0;
for (const [id, ms] of self) {
  const { callFrame: cf } = nodes.get(id);
  total += ms;
  if (cf.functionName === "(idle)" || cf.functionName === "(program)") idle += ms;
  const k = pkg(cf.url, cf.functionName);
  byPkg.set(k, (byPkg.get(k) ?? 0) + ms);
  const f = `${cf.functionName || "(anonymous)"} ${k}:${cf.lineNumber + 1}`;
  byFn.set(f, (byFn.get(f) ?? 0) + ms);
}
const busy = total - idle;
const print = (title, m) => {
  console.log(`\n== ${title} (share of busy time)`);
  for (const [k, ms] of [...m].sort((a, b) => b[1] - a[1]).slice(0, TOP)) {
    if (k.includes("(idle)") || k.includes("(program)")) continue;
    console.log(`${ms.toFixed(0).padStart(9)} ms ${((100 * ms) / busy).toFixed(1).padStart(5)}%  ${k}`);
  }
};
console.log(`wall ${total.toFixed(0)} ms, busy ${busy.toFixed(0)} ms`);
print("self time by package", byPkg);
print("self time by function", byFn);
