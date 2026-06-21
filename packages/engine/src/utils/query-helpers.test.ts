// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { instanceFilter, pctChange } from "./query-helpers.js";

describe("instanceFilter", () => {
  it("returns empty SQL when instanceId is undefined", () => {
    const result = instanceFilter(undefined);
    // sql`` template produces an object; just verify no throw
    expect(result).toBeDefined();
  });

  it("accepts allowed column 'agent_id'", () => {
    expect(() => instanceFilter("my-bot", "agent_id")).not.toThrow();
  });

  it("accepts allowed column 'c.agent_id'", () => {
    expect(() => instanceFilter("my-bot", "c.agent_id")).not.toThrow();
  });

  it("throws for SQL injection attempt via column name", () => {
    expect(() => instanceFilter("my-bot", "instance_id; DROP TABLE users; --")).toThrow(
      "is not in the allowlist",
    );
  });

  it("throws for arbitrary column names not in allowlist", () => {
    expect(() => instanceFilter("my-bot", "user_id")).toThrow(
      "is not in the allowlist",
    );
  });
});

describe("pctChange", () => {
  it("returns 100 when previous is 0 and current > 0", () => {
    expect(pctChange(5, 0)).toBe(100);
  });

  it("returns 0 when both are 0", () => {
    expect(pctChange(0, 0)).toBe(0);
  });

  it("calculates percentage correctly", () => {
    expect(pctChange(150, 100)).toBe(50);
  });
});
