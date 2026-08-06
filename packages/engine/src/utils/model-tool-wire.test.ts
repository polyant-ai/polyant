// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { sanitizeToolCallId, toModelToolName } from "./model-tool-wire.js";

describe("model tool wire identifiers", () => {
  it("keeps the established namespace mapping and replaces every other invalid character", () => {
    expect(toModelToolName("innova:valida.richiámata")).toBe("innova__valida_richi_mata");
    expect(toModelToolName("search_knowledge-v2")).toBe("search_knowledge-v2");
  });

  it("maps invalid tool call id characters to underscores", () => {
    expect(sanitizeToolCallId("hook:run/42")).toBe("hook_run_42");
  });

  it("uses a legal placeholder for empty identifiers", () => {
    expect(toModelToolName("")).toBe("_");
    expect(sanitizeToolCallId("")).toBe("_");
  });
});
