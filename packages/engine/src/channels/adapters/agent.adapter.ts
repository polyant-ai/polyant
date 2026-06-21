// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import type { ChannelType } from "../../instances/channels.store.js";
import type {
  ChannelAdapter,
  IncomingMessage,
  MessageHandler,
  OutgoingMessage,
} from "../types.js";
import type { AgentSlug } from "../../instances/identifiers.js";

/**
 * Inputs for an in-process agent-to-agent call. The adapter wraps these
 * into a synthetic IncomingMessage and re-enters the engine's message
 * handler so the callee runs through the same pipeline as a normal
 * channel turn.
 */
export interface AgentDispatchInput {
  targetInstanceId: AgentSlug;
  prompt: string;
  callerSlug: string;
  callerConversationId: string;
  parentTraceId?: string;
  depth: number;
  signal?: AbortSignal;
}

/**
 * Virtual channel adapter that lets one instance invoke another inside the
 * same process. Unlike Telegram/Slack/WhatsApp, there is no external
 * transport: dispatch() synchronously feeds an IncomingMessage into the
 * registered MessageHandler and returns the resulting text to the caller.
 *
 * Enabling the row in instance_channels for channelType="agent" is the toggle
 * that makes the instance reachable as a callee.
 */
export class AgentChannelAdapter implements ChannelAdapter {
  readonly name: ChannelType = "agent";
  private handler?: MessageHandler;

  async initialize(onMessage: MessageHandler): Promise<void> {
    this.handler = onMessage;
  }

  async sendMessage(_channelId: string, _msg: OutgoingMessage): Promise<void> {
    // No-op: agent responses are returned synchronously by dispatch(), not
    // pushed through an outbound transport.
  }

  async shutdown(): Promise<void> {
    this.handler = undefined;
  }

  /**
   * Invoke the callee instance with the given prompt. Returns the callee's
   * final text response. Throws when the adapter is not initialised.
   */
  async dispatch(input: AgentDispatchInput): Promise<string> {
    if (!this.handler) {
      throw new Error("AgentChannelAdapter not initialized");
    }
    const conversationId = `agent:${input.callerSlug}:${randomUUID()}`;
    const msg: IncomingMessage = {
      channelType: "agent",
      channelId: `agent:${input.callerSlug}`,
      agentId: input.targetInstanceId,
      userName: input.callerSlug,
      text: input.prompt,
      metadata: {
        conversationId,
        agentCall: {
          callerSlug: input.callerSlug,
          callerConversationId: input.callerConversationId,
          parentTraceId: input.parentTraceId,
          depth: input.depth,
        },
      },
    };
    const out = await this.handler(msg, input.signal);
    return out.text;
  }
}
