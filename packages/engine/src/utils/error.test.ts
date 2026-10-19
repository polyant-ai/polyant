// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { errMsg } from "./error.js";

describe("errMsg", () => {
  it("returns error.message for an Error instance", () => {
    expect(errMsg(new Error("something broke"))).toBe("something broke");
  });

  it("returns the string itself when given a string", () => {
    expect(errMsg("plain string")).toBe("plain string");
  });

  it("returns the string representation of a number", () => {
    expect(errMsg(404)).toBe("404");
  });

  it('returns "null" for null', () => {
    expect(errMsg(null)).toBe("null");
  });

  it('returns "undefined" for undefined', () => {
    expect(errMsg(undefined)).toBe("undefined");
  });
});
