// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { buildAgentCard } from "./agent-card.builder.js";
import { asInstanceSlug, asInstanceUuid } from "../../instances/identifiers.js";

// NOTE: the installed @a2a-js/sdk@1.0.0 root `AgentCard` is the v1.0
// protobuf-generated shape, not the earlier JSON-REST shape the task brief
// sketched. Differences that show up below:
//  - no top-level `url` — the JSON-RPC endpoint lives in `supportedInterfaces[0].url`.
//  - no `security` field — it's `securityRequirements` (required array).
//  - `securitySchemes`/`securityRequirements` are required (non-optional), so
//    "no auth" is represented as empty `{}`/`[]`, not `undefined`.

const baseInstance = {
  id: asInstanceUuid("00000000-0000-0000-0000-000000000001"),
  slug: asInstanceSlug("acme-bot"),
  name: "Acme Bot",
  description: "Helps with Acme things",
  authEnabled: false,
} as const;

describe("buildAgentCard", () => {
  it("should_build_a_single_conversation_skill_card_with_absolute_jsonrpc_url", () => {
    const card = buildAgentCard(baseInstance as never, "https://polyant.example.com");
    expect(card.name).toBe("Acme Bot");
    expect(card.description).toBe("Helps with Acme things");
    expect(card.supportedInterfaces[0].url).toBe("https://polyant.example.com/a2a/acme-bot/jsonrpc");
    expect(card.capabilities?.streaming).toBe(true);
    expect(card.defaultInputModes).toEqual(["text"]);
    expect(card.defaultOutputModes).toEqual(["text"]);
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0].id).toBe("conversation");
    expect(card.skills[0].tags).toEqual([]);
  });

  it("should_omit_security_when_authDisabled", () => {
    const card = buildAgentCard({ ...baseInstance, authEnabled: false } as never, "https://x");
    expect(card.securitySchemes).toEqual({});
    expect(card.securityRequirements).toEqual([]);
  });

  it("should_declare_bearer_security_when_authEnabled", () => {
    const card = buildAgentCard({ ...baseInstance, authEnabled: true } as never, "https://x");
    expect(card.securitySchemes).toHaveProperty("bearer");
    expect(card.securityRequirements.length).toBeGreaterThan(0);
  });

  it("should_pass_through_tags_when_provided", () => {
    const card = buildAgentCard(baseInstance as never, "https://x", ["sales", "crm"]);
    expect(card.skills[0].tags).toEqual(["sales", "crm"]);
  });
});
