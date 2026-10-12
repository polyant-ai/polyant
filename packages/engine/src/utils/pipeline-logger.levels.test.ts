// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// LOG_LEVEL is read once when create-logger loads, so each level needs a fresh module graph.
async function loadAt(level: string) {
  vi.resetModules();
  process.env.LOG_LEVEL = level;
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  const { pipelineLog } = await import("./pipeline-logger.js");
  return { pipelineLog, output: () => spy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n") };
}

describe("pipelineLog message text", () => {
  const original = process.env.LOG_LEVEL;
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    if (original === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = original;
  });

  it("keeps incoming and reply text out of info output but keeps the operational fields", async () => {
    const { pipelineLog, output } = await loadAt("info");
    pipelineLog.request("telegram", "my-agent", "my secret question");
    pipelineLog.supervisorDone("my-agent", 42, "my secret answer");
    expect(output()).toContain("channel=telegram");
    expect(output()).toContain("instance=my-agent");
    expect(output()).toContain("duration=42ms");
    expect(output()).not.toContain("my secret question");
    expect(output()).not.toContain("my secret answer");
  });

  it("prints truncated incoming and reply text at debug", async () => {
    const { pipelineLog, output } = await loadAt("debug");
    pipelineLog.request("telegram", "my-agent", "my secret question " + "x".repeat(200));
    pipelineLog.supervisorDone("my-agent", 42, "my secret answer");
    expect(output()).toContain("my secret question");
    expect(output()).toContain("...");
    expect(output()).toContain("my secret answer");
  });
});
