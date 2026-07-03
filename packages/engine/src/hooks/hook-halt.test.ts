// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { HOOK_HALT_KEY, extractHalt } from "./hook-types.js";
import { firstHalt } from "./hook-runner.js";
import type { HookExecutionSummary } from "./hook-types.js";

describe("extractHalt", () => {
  it("returns the message when the reserved key carries a non-empty string", () => {
    expect(extractHalt({ [HOOK_HALT_KEY]: { message: "closed" } })).toEqual({ message: "closed" });
  });

  it("returns undefined for a normal result", () => {
    expect(extractHalt({ ok: true, data: 1 })).toBeUndefined();
    expect(extractHalt("pong")).toBeUndefined();
    expect(extractHalt(null)).toBeUndefined();
  });

  it("returns undefined when message is missing or empty (malformed → no halt)", () => {
    expect(extractHalt({ [HOOK_HALT_KEY]: {} })).toBeUndefined();
    expect(extractHalt({ [HOOK_HALT_KEY]: { message: "" } })).toBeUndefined();
    expect(extractHalt({ [HOOK_HALT_KEY]: { message: 42 } })).toBeUndefined();
  });
});

describe("firstHalt", () => {
  const base: HookExecutionSummary = {
    hookId: "h", event: "message_received", actionType: "tool",
    toolName: "t", success: true, durationMs: 1,
  };

  it("returns the first summary's halt", () => {
    const summaries: HookExecutionSummary[] = [
      { ...base, hookId: "a" },
      { ...base, hookId: "b", halt: { message: "stop" } },
    ];
    expect(firstHalt(summaries)).toEqual({ message: "stop" });
  });

  it("returns undefined when no summary halts", () => {
    expect(firstHalt([base])).toBeUndefined();
  });
});
