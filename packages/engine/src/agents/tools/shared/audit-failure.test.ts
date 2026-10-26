// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";
import { auditFailure } from "./audit-failure.js";

describe("auditFailure", () => {
  afterEach(() => vi.restoreAllMocks());

  it("audits the failed call, logs under the label and returns the message", () => {
    const log = vi.fn();
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const message = auditFailure({ audit: { log } }, "memory.save", { q: "x" }, new Error("boom"), "saveMemory");
    expect(message).toBe("boom");
    expect(log).toHaveBeenCalledWith({ action: "memory.save", details: { q: "x" }, success: false, error: "boom" });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("[saveMemory]"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });

  it("omits details and the console line when none are given", () => {
    const log = vi.fn();
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    auditFailure({ audit: { log } }, "workspace.readFile", undefined, "plain");
    expect(log).toHaveBeenCalledWith({ action: "workspace.readFile", success: false, error: "plain" });
    expect(spy).not.toHaveBeenCalled();
  });
});
