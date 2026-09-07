// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { instanceBundleSchema, INSTANCE_BUNDLE_VERSION } from "./export.schema.js";

// A minimal legacy 1.0 bundle: only the fields the original format carried.
// New fields are absent — the schema must default them so old exports still
// import cleanly.
function legacyV1Bundle() {
  return {
    version: "1.0",
    exportedAt: "2026-05-01T00:00:00.000Z",
    type: "instance",
    instance: {
      slug: "acme",
      name: "Acme",
      description: null,
      status: "active",
      provider: "openai",
      model: "gpt-4o",
      memoryEnabled: true,
      knowledgeEnabled: false,
      langsmithEnabled: false,
      authEnabled: false,
      prompts: [],
      skills: [],
      manualTools: [],
      secrets: [],
      channels: [{ channelType: "telegram", enabled: true }],
      skillEnv: [],
      room: null,
      eventSources: [
        {
          name: "src",
          sourceType: "generic",
          enabled: true,
          definitions: [
            {
              name: "def",
              matchingPrompt: "m",
              interpretationPrompt: "i",
              enabled: true,
            },
          ],
        },
      ],
    },
  };
}

describe("instanceBundleSchema back-compat", () => {
  it("should_parse_a_legacy_1.0_bundle_and_default_the_new_fields", () => {
    const parsed = instanceBundleSchema.parse(legacyV1Bundle());
    const inst = parsed.instance;

    // New behaviour flags default to the column defaults.
    expect(inst.thinkingEnabled).toBe(false);
    expect(inst.stateInPromptEnabled).toBe(false);
    expect(inst.toolResultsInHistoryEnabled).toBe(false);
    expect(inst.debugEnabled).toBe(false);
    expect(inst.sttProvider).toBe("openai");
    expect(inst.embeddingProvider).toBe("openai");
    expect(inst.embeddingDim).toBe(1536);
    expect(inst.langsmithProject).toBeNull();

    // Opt-out config defaults.
    expect(inst.optoutEnabled).toBe(false);
    expect(inst.optoutStopKeywords).toEqual(["STOP"]);
    expect(inst.optoutResumeKeywords).toEqual(["START"]);
    expect(inst.optoutInjectPromptHint).toBe(true);

    // New collections default to empty.
    expect(inst.hooks).toEqual([]);

    // Legacy channel without config defaults to an empty config object.
    expect(inst.channels[0]?.config).toEqual({});

    // Legacy event definition gets the routing defaults.
    const def = inst.eventSources[0]?.definitions[0];
    expect(def?.action).toBe("backlog");
    expect(def?.contextPrompt).toBeNull();
    expect(def?.outboundChannel).toBeNull();
    expect(def?.outboundTarget).toBeNull();
  });

  it("defaults temperature to null for legacy bundles", () => {
    const parsed = instanceBundleSchema.parse({ ...legacyV1Bundle() });
    expect(parsed.instance.temperature).toBeNull();
  });
  it("preserves temperature when present", () => {
    const bundle = legacyV1Bundle();
    (bundle.instance as Record<string, unknown>).temperature = 0.4;
    const parsed = instanceBundleSchema.parse(bundle);
    expect(parsed.instance.temperature).toBe(0.4);
  });

  it("should_accept_the_current_1.1_version_literal", () => {
    const bundle = legacyV1Bundle();
    bundle.version = INSTANCE_BUNDLE_VERSION;
    expect(() => instanceBundleSchema.parse(bundle)).not.toThrow();
  });

  it("should_reject_an_unknown_version", () => {
    const bundle = legacyV1Bundle();
    (bundle as { version: string }).version = "2.0";
    expect(() => instanceBundleSchema.parse(bundle)).toThrow();
  });

  it("should_accept_the_1.2_version_literal", () => {
    const bundle = legacyV1Bundle();
    (bundle as { version: string }).version = "1.2";
    expect(() => instanceBundleSchema.parse(bundle)).not.toThrow();
  });

  it("should_default_mcpServers_to_empty_for_legacy_bundles", () => {
    const parsed = instanceBundleSchema.parse(legacyV1Bundle());
    expect(parsed.instance.mcpServers).toEqual([]);
  });

  it("should_round_trip_an_mcp_server_entry_on_a_1.2_bundle", () => {
    const bundle = legacyV1Bundle();
    (bundle as { version: string }).version = "1.2";
    (bundle.instance as Record<string, unknown>).mcpServers = [
      {
        slug: "github",
        name: "GitHub",
        url: "https://mcp.example.com",
        authMode: "static",
        enabled: false,
        config: { auth: { type: "bearer" } },
      },
    ];

    const parsed = instanceBundleSchema.parse(bundle);
    expect(parsed.instance.mcpServers[0]).toMatchObject({
      slug: "github",
      name: "GitHub",
      url: "https://mcp.example.com",
      authMode: "static",
      enabled: false,
    });
  });

  it("should_round_trip_hooks_and_channel_config_on_a_1.1_bundle", () => {
    const bundle = legacyV1Bundle();
    bundle.version = INSTANCE_BUNDLE_VERSION;
    (bundle.instance as Record<string, unknown>).hooks = [
      {
        event: "message_received",
        actionType: "tool",
        actionConfig: { toolName: "slackPostMessage", args: { channel: "#ops" } },
        enabled: true,
        position: 0,
        timeoutMs: 10_000,
      },
    ];
    bundle.instance.channels = [{ channelType: "agent", enabled: true, config: {} } as never];

    const parsed = instanceBundleSchema.parse(bundle);
    expect(parsed.instance.hooks[0]?.actionConfig).toMatchObject({
      toolName: "slackPostMessage",
    });
    expect(parsed.instance.channels[0]?.channelType).toBe("agent");
  });
});

// stripSensitiveKeys now has its own module + test file: see
// channel-config-sanitize.ts / channel-config-sanitize.test.ts.
