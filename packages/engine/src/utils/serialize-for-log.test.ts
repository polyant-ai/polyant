// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { serializeForLog } from "./serialize-for-log.js";

describe("serializeForLog", () => {
  /*
    The reason this module exists. `message` and `stack` are NON-ENUMERABLE, so
    `JSON.stringify(err)` drops exactly the diagnostic text and keeps the custom
    fields — and driver errors from pg, the AWS SDK and fetch routinely carry the
    connection string, the request config or the authorization header there.
    index.ts already states the policy for the process-level handlers; the file
    logger, which is what actually lands on disk for fourteen days, did the
    opposite.
  */
  it("should_prove_JSON_stringify_is_the_wrong_tool_for_an_Error", () => {
    const err = Object.assign(new Error("boom"), { authorization: "Bearer sk-live-a91f" });
    const naive = JSON.stringify(err);
    expect(naive).not.toContain("boom");
    expect(naive).toContain("sk-live-a91f");
  });

  it("should_keep_an_Error_message_and_drop_its_custom_fields", () => {
    const err = Object.assign(new Error("boom"), {
      url: "https://api.example.com/v1?key=sk-live-a91f",
      responseHeaders: { authorization: "Bearer sk-live-a91f" },
    });

    const out = serializeForLog(err);

    expect(out).toContain("boom");
    expect(out).not.toContain("sk-live-a91f");
  });

  it("should_keep_an_Error_nested_inside_an_object_from_leaking_its_fields", () => {
    const err = Object.assign(new Error("inner"), { apiKey: "sk-live-a91f" });
    const out = serializeForLog({ context: "provider call", cause: err });

    expect(out).toContain("inner");
    expect(out).not.toContain("sk-live-a91f");
  });

  it("should_redact_a_credential_shaped_key_at_any_depth", () => {
    const out = serializeForLog({ a: { b: { apiKey: "sk-live-a91f", n: 1 } } });

    expect(out).toContain('"apiKey":"[redacted]"');
    expect(out).toContain('"n":1');
    expect(out).not.toContain("sk-live-a91f");
  });

  it("should_redact_every_spelling_the_codebase_actually_produces", () => {
    const out = serializeForLog({
      authorization: "x", api_key: "x", "api-key": "x", token: "x", accessToken: "x",
      secret: "x", password: "x", credential: "x", connectionString: "x", cookie: "x",
    });

    expect(out).not.toContain('"x"');
  });

  it("should_leave_an_innocent_key_alone", () => {
    const out = serializeForLog({ tokenCount: 42, keyboard: "qwerty" });

    expect(out).toContain('"tokenCount":42');
    expect(out).toContain('"keyboard":"qwerty"');
  });

  it("should_cap_a_long_value_and_say_it_did", () => {
    const out = serializeForLog({ blob: "x".repeat(10_000) }, { maxLength: 200 });

    expect(out.length).toBeLessThan(260);
    expect(out).toMatch(/…\[truncated \d+ chars\]$/);
  });

  it("should_not_throw_on_a_circular_structure", () => {
    const a: Record<string, unknown> = { name: "root" };
    a.self = a;

    expect(() => serializeForLog(a)).not.toThrow();
    expect(serializeForLog(a)).toContain("root");
  });

  it("should_pass_a_string_through_unchanged", () => {
    expect(serializeForLog("already text")).toBe("already text");
  });
});
