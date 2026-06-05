// SPDX-License-Identifier: AGPL-3.0-or-later

import { App } from "@slack/bolt";
import type { ChannelAdapter, IncomingMessage, MessageHandler, OutgoingMessage } from "../../types.js";
import { CHANNEL_MAX_LENGTH, METADATA_CONVERSATION_ID_OVERRIDE } from "../../types.js";
import { toSlackMrkdwn } from "./slack-mrkdwn.js";
import { splitMessage } from "../../split-message.js";
import type { InstanceSlug } from "../../../instances/identifiers.js";

export interface SlackConfig {
  botToken: string;
  appToken: string;
  signingSecret: string;
}

const USER_CACHE_TTL_MS = 10 * 60 * 1000;

export class SlackAdapter implements ChannelAdapter {
  name = "slack" as const;
  private app: App | null = null;
  private botUserId: string | null = null;
  private mentionRegex: RegExp | null = null;
  private readonly userCache = new Map<string, { name: string; expiresAt: number }>();

  constructor(
    private readonly instanceId: InstanceSlug,
    private readonly cfg: SlackConfig,
  ) {}

  async initialize(onMessage: MessageHandler): Promise<void> {
    const { botToken, appToken, signingSecret } = this.cfg;

    this.app = new App({
      token: botToken,
      signingSecret,
      socketMode: true,
      appToken,
    });

    const auth = await this.app.client.auth.test({ token: botToken });
    if (!auth.user_id) {
      throw new Error("Slack auth.test did not return user_id — invalid bot token?");
    }
    this.botUserId = auth.user_id;
    this.mentionRegex = new RegExp(`<@${this.botUserId}>\\s*`, "g");

    // Direct messages to the bot (channel_type === "im"). We register on
    // .message() to also catch DMs that come without an explicit mention.
    this.app.message(async ({ message, say, client }) => {
      if (!this.isPlainTextMessage(message)) return;
      // Only DMs here — channel mentions are handled by app_mention below to
      // avoid double-firing.
      if ((message as { channel_type?: string }).channel_type !== "im") return;

      const userId = (message as { user?: string }).user;
      const text = (message as { text: string }).text;
      const ts = (message as { ts: string }).ts;
      const threadTs = (message as { thread_ts?: string }).thread_ts;
      const channel = (message as { channel: string }).channel;

      const userName = userId ? await this.resolveUserName(client, userId) : undefined;

      const incoming: IncomingMessage = {
        channelType: "slack",
        channelId: channel,
        instanceId: this.instanceId,
        userName,
        text,
        metadata: {
          ts,
          threadTs,
          // DM = single ongoing 1:1 conversation, keyed on channel only.
          [METADATA_CONVERSATION_ID_OVERRIDE]: `${this.instanceId}:slack:${channel}`,
        },
      };

      const response = await onMessage(incoming);
      if (response.text) {
        for (const chunk of this.formatForSlack(response.text)) {
          await say({ text: chunk, thread_ts: threadTs });
        }
      }
    });

    // Channel mentions: only respond when explicitly tagged. Bolt routes
    // app_mention events here, deduped from the generic message stream.
    //
    // Reply behavior: post at top level (no thread_ts on say), so the answer
    // appears in the main channel feed. Conversation segmentation still uses
    // the mention's thread root in conversationIdOverride below.
    this.app.event("app_mention", async ({ event, say, client }) => {
      if (event.bot_id) return;
      if (!event.text) return;

      const cleanText = this.stripMention(event.text).trim();
      if (!cleanText) return;

      const userName = event.user ? await this.resolveUserName(client, event.user) : undefined;
      const threadTs = event.thread_ts ?? event.ts;

      const incoming: IncomingMessage = {
        channelType: "slack",
        channelId: event.channel,
        instanceId: this.instanceId,
        userName,
        text: cleanText,
        metadata: {
          ts: event.ts,
          threadTs,
          // One conversation per thread, so different mentions in the same
          // channel don't collapse into a single mixed history.
          [METADATA_CONVERSATION_ID_OVERRIDE]: `${this.instanceId}:slack:${event.channel}:${threadTs}`,
        },
      };

      const response = await onMessage(incoming);
      if (response.text) {
        for (const chunk of this.formatForSlack(response.text)) {
          await say({ text: chunk });
        }
      }
    });

    await this.app.start();
    console.log(`Slack bot started for instance "${this.instanceId}" (socket mode, botUserId=${this.botUserId})`);
  }

  async sendMessage(channelId: string, msg: OutgoingMessage): Promise<void> {
    if (!this.app) throw new Error("Slack app not initialized");

    // If target is a user ID (U...), open a DM first
    let resolvedChannel = channelId;
    if (channelId.startsWith("U")) {
      const dm = await this.app.client.conversations.open({ users: channelId });
      if (dm.channel?.id) resolvedChannel = dm.channel.id;
    }

    for (const text of this.formatForSlack(msg.text)) {
      await this.app.client.chat.postMessage({
        channel: resolvedChannel,
        text,
      });
    }
  }

  async shutdown(): Promise<void> {
    if (this.app) {
      await this.app.stop();
    }
  }

  /**
   * Splits a response to Slack's per-message length limit and converts each
   * chunk to Slack mrkdwn. Shared by both inbound replies (`say`) and proactive
   * `sendMessage` so every outbound path renders formatting consistently.
   */
  private formatForSlack(text: string): string[] {
    return splitMessage(text, CHANNEL_MAX_LENGTH.slack).map(toSlackMrkdwn);
  }

  private isPlainTextMessage(message: unknown): message is { text: string; user?: string; channel: string; ts: string } {
    if (typeof message !== "object" || message === null) return false;
    const m = message as Record<string, unknown>;
    if (m.subtype !== undefined) return false;
    if (m.bot_id !== undefined) return false;
    if (typeof m.text !== "string" || !m.text) return false;
    return true;
  }

  private stripMention(text: string): string {
    if (!this.mentionRegex) return text;
    return text.replace(this.mentionRegex, "");
  }

  private async resolveUserName(client: App["client"], userId: string): Promise<string> {
    const cached = this.userCache.get(userId);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.name;

    try {
      const info = await client.users.info({ user: userId });
      const profile = info.user?.profile;
      const name =
        profile?.display_name ||
        profile?.real_name ||
        info.user?.real_name ||
        info.user?.name ||
        userId;
      this.userCache.set(userId, { name, expiresAt: now + USER_CACHE_TTL_MS });
      return name;
    } catch (err) {
      console.warn(`[slack] users.info failed for ${userId}:`, err instanceof Error ? err.message : err);
      return userId;
    }
  }
}
