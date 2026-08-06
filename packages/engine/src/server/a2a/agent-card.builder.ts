// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AgentCard } from "@a2a-js/sdk";
import type { Agent } from "../../instances/store.js";

const JSONRPC_PROTOCOL_VERSION = "1.0";

/**
 * Build the A2A Agent Card for an instance. Pure: card content derives only
 * from instance metadata + the public base URL. A Polyant instance is a
 * conversational agent, so it advertises a single generic "conversation" skill.
 *
 * The installed `@a2a-js/sdk@1.0.0` root `AgentCard` is the v1.0
 * protobuf-generated shape (no top-level `url`/`protocolVersion`/`security` —
 * see `supportedInterfaces`/`securitySchemes`/`securityRequirements` below),
 * not the earlier JSON-REST shape. `securitySchemes`/`securityRequirements`
 * are required (non-optional) fields there, so "no auth" is represented as
 * an empty map/array rather than `undefined`.
 */
export function buildAgentCard(instance: Agent, baseUrl: string, tags: string[] = []): AgentCard {
  const jsonRpcUrl = `${baseUrl}/a2a/${instance.slug}/jsonrpc`;
  const description = instance.description ?? "";

  const card: AgentCard = {
    name: instance.name,
    description,
    version: "1.0.0",
    provider: undefined,
    supportedInterfaces: [
      { url: jsonRpcUrl, protocolBinding: "JSONRPC", tenant: "", protocolVersion: JSONRPC_PROTOCOL_VERSION },
    ],
    capabilities: { streaming: true, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: [
      {
        id: "conversation",
        name: "Conversation",
        description: description || instance.name,
        tags,
        examples: [],
        inputModes: [],
        outputModes: [],
        securityRequirements: [],
      },
    ],
    signatures: [],
  };

  if (instance.authEnabled) {
    card.securitySchemes = {
      bearer: {
        scheme: {
          $case: "httpAuthSecurityScheme",
          value: { description: "Per-instance API key", scheme: "Bearer", bearerFormat: "" },
        },
      },
    };
    card.securityRequirements = [{ schemes: { bearer: { list: [] } } }];
  }

  return card;
}
