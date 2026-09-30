// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";
import { readableKeysOf, readableSecretKeys } from "./readable-secret-keys.js";
import { _registerToolForTests, _resetRegistryForTests } from "../agents/tools/registry.js";
import { _registerHookForTests, _resetHookRegistryForTests } from "../hooks/hook-registry.js";
import type { RequiredSecretSpec } from "../agents/tools/registry.js";

function spec(key: string, sensitive: boolean): RequiredSecretSpec {
  return { key, type: "text", sensitive };
}

describe("readableKeysOf", () => {
  it("should_make_readable_a_key_declared_not_sensitive", () => {
    expect(readableKeysOf([{ requiredSecrets: [spec("crm_base_url", false)] }])).toEqual(new Set(["crm_base_url"]));
  });

  it("should_never_make_readable_a_key_declared_sensitive", () => {
    expect(readableKeysOf([{ requiredSecrets: [spec("crm_api_key", true)] }])).toEqual(new Set());
  });

  it("should_treat_as_a_credential_a_key_one_source_declares_sensitive", () => {
    const sources = [
      { requiredSecrets: [spec("shared_key", false)] },
      { requiredSecrets: [spec("shared_key", true)] },
    ];
    expect(readableKeysOf(sources)).toEqual(new Set());
  });

  it("should_treat_as_a_credential_a_key_no_source_declares", () => {
    expect(readableKeysOf([{ requiredSecrets: undefined }]).has("openai_api_key")).toBe(false);
  });
});

describe("readableSecretKeys", () => {
  afterEach(() => {
    _resetRegistryForTests();
    _resetHookRegistryForTests();
  });

  it("should_read_the_verdict_from_both_the_tool_and_the_hook_registry", () => {
    _registerToolForTests(
      defineTool({
        name: "lookupDeal",
        description: "test tool",
        parameters: z.object({}),
        // A `select` normalizes to readable, a bare string to a credential.
        requiredSecrets: [{ key: "crm_region", type: "select", choices: ["eu", "us"] }, "crm_api_key"],
        execute: async () => ({}),
      }),
    );
    _registerHookForTests({
      name: "tagLead",
      description: "test hook",
      requiredSecrets: [spec("lead_tag", false)],
      handler: () => undefined,
    });

    expect(readableSecretKeys()).toEqual(new Set(["crm_region", "lead_tag"]));
  });

  it("should_let_a_harness_tool_veto_a_key_another_tool_declares_readable", () => {
    _registerToolForTests(
      defineTool({
        name: "readable",
        description: "test tool",
        parameters: z.object({}),
        requiredSecrets: [spec("shared_key", false)],
        execute: async () => ({}),
      }),
    );
    _registerToolForTests({
      ...defineTool({
        name: "harnessOnly",
        description: "test harness tool",
        parameters: z.object({}),
        requiredSecrets: [spec("shared_key", true)],
        execute: async () => ({}),
      }),
      harness: true,
    });

    expect(readableSecretKeys().has("shared_key")).toBe(false);
  });
});
