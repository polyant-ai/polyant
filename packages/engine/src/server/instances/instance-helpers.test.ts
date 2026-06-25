// SPDX-License-Identifier: AGPL-3.0-or-later

import { NotFoundException } from "@nestjs/common";

const { mockFindInstance } = vi.hoisted(() => ({
  mockFindInstance: vi.fn(),
}));

vi.mock("../../instances/store.js", () => ({ findInstanceBySlug: mockFindInstance }));

import { findInstanceOrFail, maskSensitiveConfig, errMsg } from "./instance-helpers.js";

// ---------------------------------------------------------------------------
// findInstanceOrFail
// ---------------------------------------------------------------------------
describe("findInstanceOrFail", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns instance when the slug exists", async () => {
    const fakeInstance = { id: "uuid-1", slug: "my-bot" };
    mockFindInstance.mockResolvedValue(fakeInstance);

    const result = await findInstanceOrFail("my-bot");

    expect(result).toBe(fakeInstance);
    expect(mockFindInstance).toHaveBeenCalledWith("my-bot");
  });

  it("throws NotFoundException when the slug does not exist", async () => {
    mockFindInstance.mockResolvedValue(undefined);

    await expect(findInstanceOrFail("ghost")).rejects.toThrow(NotFoundException);
    await expect(findInstanceOrFail("ghost")).rejects.toThrow('Agent "ghost" not found');
  });
});

// ---------------------------------------------------------------------------
// maskSensitiveConfig
// ---------------------------------------------------------------------------
describe("maskSensitiveConfig", () => {
  it("masks fields whose names match the sensitive pattern", () => {
    const cfg = {
      token: "abcdef123456",
      secret: "mysecretvalue1",
      password: "hunter2xxxx",
      key: "sk-abcdefgh",
      credential: "cred-999888",
    };

    const result = maskSensitiveConfig(cfg);

    expect(result.token).toBe("••••3456");
    expect(result.secret).toBe("••••lue1");
    expect(result.password).toBe("••••xxxx");
    expect(result.key).toBe("••••efgh");
    expect(result.credential).toBe("••••9888");
  });

  it("shows last 4 chars with the •••• prefix", () => {
    const result = maskSensitiveConfig({ apiKey: "abcdefghijklmnop" });
    expect(result.apiKey).toBe("••••mnop");
  });

  it("does NOT mask non-matching field names", () => {
    const cfg = { name: "Paolo", host: "localhost", port: "5432" };
    const result = maskSensitiveConfig(cfg);

    expect(result.name).toBe("Paolo");
    expect(result.host).toBe("localhost");
    expect(result.port).toBe("5432");
  });

  it("does NOT mask empty strings even if the key matches", () => {
    const result = maskSensitiveConfig({ token: "", secret: "" });

    expect(result.token).toBe("");
    expect(result.secret).toBe("");
  });

  it("does NOT mask non-string values (numbers, booleans)", () => {
    const cfg = { secretCount: 42, tokenEnabled: true, keyIndex: 0 };
    const result = maskSensitiveConfig(cfg);

    expect(result.secretCount).toBe(42);
    expect(result.tokenEnabled).toBe(true);
    expect(result.keyIndex).toBe(0);
  });

  it("is case insensitive: API_KEY, apiKey, ApiToken are all masked", () => {
    const cfg = {
      API_KEY: "value-api-key1",
      apiKey: "value-api-key2",
      ApiToken: "value-api-tokn",
    };
    const result = maskSensitiveConfig(cfg);

    expect(result.API_KEY).toBe("••••key1");
    expect(result.apiKey).toBe("••••key2");
    expect(result.ApiToken).toBe("••••tokn");
  });

  it("handles a mixed config object correctly", () => {
    const cfg = {
      name: "my-instance",
      apiKey: "sk-1234567890ab",
      port: 3000,
      password: "",
      dbSecret: "supersecret!",
      debug: false,
    };
    const result = maskSensitiveConfig(cfg);

    expect(result).toEqual({
      name: "my-instance",
      apiKey: "••••90ab",
      port: 3000,
      password: "",         // empty string, not masked
      dbSecret: "••••ret!",
      debug: false,
    });
  });
});

// ---------------------------------------------------------------------------
// errMsg
// ---------------------------------------------------------------------------
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
