// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A domain fact that explains a refusal, for callers that react to the cause
 * rather than read the message: the agent lacks the key its model provider
 * needs, or the key a channel needs.
 */
export type AgentRefusalReason = "missing_provider_key" | "missing_channel_key";

/**
 * A request on an agent's configuration that the domain refuses, worded for
 * the caller. HTTP routes answer it as 400/404/409 with the same message.
 * `reason`, when set, names the fact behind the refusal.
 */
export class AgentRequestRefusedError extends Error {
  constructor(
    message: string,
    readonly kind: "invalid" | "not_found" | "conflict",
    readonly reason?: AgentRefusalReason,
  ) {
    super(message);
    this.name = "AgentRequestRefusedError";
  }
}
