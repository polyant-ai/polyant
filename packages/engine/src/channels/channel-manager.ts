// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ChannelAdapter, MessageHandler, IncomingMessage, OutgoingMessage } from "./types.js";
import type { ChannelType } from "../instances/channels.store.js";
import { listEnabledChannelConfigs, disableChannel } from "../instances/channels.store.js";
import { TelegramAdapter, type TelegramConfig } from "./adapters/telegram/index.js";
import { SlackAdapter, type SlackConfig } from "./adapters/slack/index.js";
import { WhatsAppAdapter, type WhatsAppConfig } from "./adapters/whatsapp/index.js";
import { AgentChannelAdapter } from "./adapters/agent.adapter.js";
import { MessageCoordinator } from "./message-coordinator.js";
import { config } from "../config.js";
import { emitOutbound } from "../activity-stream/emitters/emit-outbound.js";
import { resolveInstanceMeta } from "../activity-stream/emit-helpers.js";
import { asInstanceSlug } from "../instances/identifiers.js";

/**
 * Channel types that should NOT produce `category: "outbound"` events:
 *   - `agent` → covered by `emitAgentHandoffEnd` (dual-avatar row)
 * Everything else emits on every send (success or error).
 */
const OUTBOUND_SUPPRESSED_CHANNELS = new Set(["agent"]);

/** Channels that route inbound messages through the fragment debouncer. */
const DEBOUNCED_CHANNELS: ReadonlySet<ChannelType> = new Set<ChannelType>(["whatsapp", "telegram"]);

/** Map<instanceSlug, Map<channelType, ChannelAdapter>> */
type InstanceAdapters = Map<string, Map<string, ChannelAdapter>>;

export class ChannelManager {
  private adapters: InstanceAdapters = new Map();
  private messageHandler: MessageHandler | null = null;
  private coordinator: MessageCoordinator | null = null;

  /** Set the global message handler (agent pipeline) */
  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /** Create a wrapped handler with logging + error recovery + optional coordinator */
  private wrapHandler(): MessageHandler {
    if (!this.messageHandler) {
      throw new Error("Message handler not set. Call setMessageHandler() first.");
    }
    const handler = this.messageHandler;

    const loggedPipeline: MessageHandler = async (msg: IncomingMessage, signal?: AbortSignal): Promise<OutgoingMessage> => {
      console.log(`[${msg.channelType}] [${msg.instanceId}] Incoming message from ${msg.userName ?? "unknown"}`);
      try {
        const response = await handler(msg, signal);
        console.log(`[${msg.channelType}] [${msg.instanceId}] Response sent`);
        return response;
      } catch (err) {
        // Let AbortErrors bubble up so the coordinator can recognise a cancel-and-restart.
        if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
          throw err;
        }
        console.error("[%s] [%s] Error handling message:", msg.channelType, msg.instanceId, err);
        return {
          text: "I apologize, an error occurred while processing your request. Please try again shortly.",
        };
      }
    };

    // Lazy-init the coordinator singleton on first wrap. It is captured by
    // closure below so further wrap() calls keep using the same instance —
    // otherwise each channel restart would create an orphan state map.
    if (!this.coordinator) {
      this.coordinator = new MessageCoordinator({
        softDebounceMs: config.coordinator.softDebounceMs,
        typingDelayMs: config.coordinator.typingDelayMs,
        maxRestarts: config.coordinator.maxRestarts,
        handler: (msg, signal) => loggedPipeline(msg, signal),
        sendOutbound: (slug, channelType, channelId, text) =>
          this.sendOutbound(slug, channelType, channelId, text),
        sendTyping: (slug, channelType, channelId, messageSid) =>
          this.dispatchSendTyping(slug, channelType, channelId, messageSid),
      });
      console.log(
        `[channel-manager] MessageCoordinator enabled: softDebounce=${config.coordinator.softDebounceMs}ms, typingDelay=${config.coordinator.typingDelayMs}ms, maxRestarts=${config.coordinator.maxRestarts}, channels=${[...DEBOUNCED_CHANNELS].join(",")}`,
      );
    }
    const coordinator = this.coordinator;

    return async (msg: IncomingMessage): Promise<OutgoingMessage> => {
      if (DEBOUNCED_CHANNELS.has(msg.channelType as ChannelType)) {
        return coordinator.onMessage(msg);
      }
      return loggedPipeline(msg);
    };
  }

  /** Coordinator callback: locate the adapter and delegate the typing indicator. */
  private async dispatchSendTyping(
    instanceSlug: string,
    channelType: string,
    channelId: string,
    messageSid?: string,
  ): Promise<void> {
    const adapter = this.adapters.get(instanceSlug)?.get(channelType);
    if (!adapter?.sendTyping) return;
    await adapter.sendTyping(channelId, messageSid);
  }

  /** Start a single channel adapter for an instance. */
  async startChannel(instanceSlug: string, channelType: string, config: Record<string, unknown>): Promise<void> {
    // Stop existing adapter for this instance+channel if running
    await this.stopChannel(instanceSlug, channelType);

    const adapter = this.createAdapter(instanceSlug, channelType as ChannelType, config);
    if (!adapter) return;

    const wrappedHandler = this.wrapHandler();

    try {
      await adapter.initialize(wrappedHandler);

      let instanceMap = this.adapters.get(instanceSlug);
      if (!instanceMap) {
        instanceMap = new Map();
        this.adapters.set(instanceSlug, instanceMap);
      }
      instanceMap.set(channelType, adapter);

      console.log(`Channel started: ${channelType} for instance "${instanceSlug}"`);
    } catch (err) {
      console.error('Failed to start channel %s for instance "%s":', channelType, instanceSlug, err);
      // Auto-disable the channel in DB to prevent crash loops on restart
      this.autoDisableChannel(instanceSlug, channelType).catch((disableErr) =>
        console.error('Failed to auto-disable %s for "%s":', channelType, instanceSlug, disableErr),
      );
    }
  }

  /** Stop a single channel adapter for an instance. */
  async stopChannel(instanceSlug: string, channelType: string): Promise<void> {
    const instanceMap = this.adapters.get(instanceSlug);
    if (!instanceMap) return;

    const adapter = instanceMap.get(channelType);
    if (!adapter) return;

    try {
      await adapter.shutdown();
    } catch (err) {
      console.error('Error shutting down %s for instance "%s":', channelType, instanceSlug, err);
    }
    instanceMap.delete(channelType);

    if (instanceMap.size === 0) {
      this.adapters.delete(instanceSlug);
    }
  }

  /** Start all enabled channels for an instance (reads from DB). */
  async startAllForInstance(instanceSlug: string): Promise<void> {
    const channels = await listEnabledChannelConfigs(asInstanceSlug(instanceSlug));

    await Promise.allSettled(
      channels.map((ch) => this.startChannel(instanceSlug, ch.channelType, ch.config)),
    );
  }

  /** Stop all channels for an instance. */
  async stopAllForInstance(instanceSlug: string): Promise<void> {
    const instanceMap = this.adapters.get(instanceSlug);
    if (!instanceMap) return;

    const promises = Array.from(instanceMap.entries()).map(async ([type, adapter]) => {
      try {
        await adapter.shutdown();
      } catch (err) {
        console.error('Error shutting down %s for instance "%s":', type, instanceSlug, err);
      }
    });
    await Promise.all(promises);
    this.adapters.delete(instanceSlug);
  }

  /** Gracefully shut down all adapters across all instances. */
  async shutdownAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [slug] of this.adapters) {
      promises.push(this.stopAllForInstance(slug));
    }
    await Promise.all(promises);
  }

  /** Send a proactive outbound message via a running channel adapter. */
  async sendOutbound(
    instanceSlug: string,
    channelType: string,
    channelId: string,
    message: string,
    opts?: { mediaUrl?: string | string[] },
  ): Promise<void> {
    const instanceMap = this.adapters.get(instanceSlug);
    if (!instanceMap) throw new Error(`No active channels for instance "${instanceSlug}"`);

    const adapter = instanceMap.get(channelType);
    if (!adapter) throw new Error(`Channel "${channelType}" not active for instance "${instanceSlug}"`);

    let ok = false;
    let errorMessage: string | undefined;
    try {
      await adapter.sendMessage(channelId, {
        text: message,
        ...(opts?.mediaUrl ? { mediaUrl: opts.mediaUrl } : {}),
      });
      ok = true;
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      // Activity-stream emit: success/error parity for proactive outbound sends.
      // Skipped for `agent` (covered by emitAgentHandoffEnd). Fire-and-forget.
      if (!OUTBOUND_SUPPRESSED_CHANNELS.has(channelType)) {
        resolveInstanceMeta(instanceSlug)
          .then((instance) => {
            emitOutbound({
              channelType,
              channelId,
              text: message,
              ok,
              error: errorMessage,
              instance,
            });
          })
          .catch(() => {
            /* resolveInstanceMeta swallows internally; guard the chain */
          });
      }
    }
  }

  /**
   * Send a structured template via a running channel adapter that supports it.
   * Throws if the adapter does not implement `sendTemplate`.
   */
  async sendOutboundTemplate(
    instanceSlug: string,
    channelType: string,
    channelId: string,
    contentSid: string,
    variables: Record<string, string>,
  ): Promise<string> {
    const instanceMap = this.adapters.get(instanceSlug);
    if (!instanceMap) throw new Error(`No active channels for instance "${instanceSlug}"`);

    const adapter = instanceMap.get(channelType);
    if (!adapter) throw new Error(`Channel "${channelType}" not active for instance "${instanceSlug}"`);

    if (!adapter.sendTemplate) {
      throw new Error(`Channel "${channelType}" does not support template messages`);
    }

    return adapter.sendTemplate(channelId, contentSid, variables);
  }

  /**
   * Resolve the rendered body of an approved template (with `{{N}}` variables
   * substituted) for persistence in conversation history. Delegates to the
   * adapter's `getTemplateBody`. Currently only WhatsApp implements this —
   * other channels throw.
   */
  async getOutboundTemplateBody(
    instanceSlug: string,
    channelType: string,
    contentSid: string,
    variables: Record<string, string>,
  ): Promise<string> {
    const instanceMap = this.adapters.get(instanceSlug);
    if (!instanceMap) throw new Error(`No active channels for instance "${instanceSlug}"`);

    const adapter = instanceMap.get(channelType);
    if (!adapter) throw new Error(`Channel "${channelType}" not active for instance "${instanceSlug}"`);

    if (!adapter.getTemplateBody) {
      throw new Error(`Channel "${channelType}" does not support template body resolution`);
    }

    return adapter.getTemplateBody(contentSid, variables);
  }

  /** Get summary of active channels. */
  getActiveChannels(): Array<{ instanceSlug: string; channelType: string }> {
    const result: Array<{ instanceSlug: string; channelType: string }> = [];
    for (const [slug, instanceMap] of this.adapters) {
      for (const [type] of instanceMap) {
        result.push({ instanceSlug: slug, channelType: type });
      }
    }
    return result;
  }

  /** Auto-disable a channel in DB after adapter initialization failure. */
  private async autoDisableChannel(instanceSlug: string, channelType: string): Promise<void> {
    await disableChannel(asInstanceSlug(instanceSlug), channelType);
    console.warn(`Channel auto-disabled: ${channelType} for instance "${instanceSlug}" — re-enable from admin panel after fixing credentials`);
  }

  /** Create the appropriate adapter based on channel type. */
  private createAdapter(instanceSlug: string, channelType: ChannelType, config: Record<string, unknown>): ChannelAdapter | null {
    const slug = asInstanceSlug(instanceSlug);
    switch (channelType) {
      case "telegram":
        return new TelegramAdapter(slug, config as unknown as TelegramConfig);
      case "slack":
        return new SlackAdapter(slug, config as unknown as SlackConfig);
      case "whatsapp":
        return new WhatsAppAdapter(slug, config as unknown as WhatsAppConfig);
      case "agent":
        // agent: virtual in-process, dispatched directly via adapter.dispatch()
        return new AgentChannelAdapter();
      default:
        console.warn(`Unknown channel type: ${channelType}`);
        return null;
    }
  }

  /**
   * Retrieve a running adapter for a given instance + channel type. Used by
   * the supervisor to obtain the AgentChannelAdapter and call dispatch()
   * when synthesising `ask_{slug}` tools.
   */
  public getAdapter(instanceSlug: string, channelType: ChannelType): ChannelAdapter | undefined {
    return this.adapters.get(instanceSlug)?.get(channelType);
  }
}

export const channelManager = new ChannelManager();
