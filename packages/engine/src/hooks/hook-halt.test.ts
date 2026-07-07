// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { firstHalt } from "./hook-runner.js";
import type { HookExecutionSummary } from "./hook-types.js";

describe("firstHalt", () => {
  const base: HookExecutionSummary = {
    hookId: "h", event: "message_received", actionType: "function",
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
