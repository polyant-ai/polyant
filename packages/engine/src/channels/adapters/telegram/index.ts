// SPDX-License-Identifier: AGPL-3.0-or-later

import { Bot } from "grammy";
import { createHash } from "node:crypto";
import type { ChannelAdapter, Attachment, MessageHandler, OutgoingMessage } from "../../types.js";
import { CHANNEL_MAX_LENGTH } from "../../types.js";
import { toTelegramMarkdownV2 } from "./markdown-v2.js";
import { splitMessage } from "../../split-message.js";
import { transcribeAudio } from "../../audio-transcription.js";
import type { InstanceSlug } from "../../../instances/identifiers.js";

export interface TelegramConfig {
  botToken: string;
  allowedUserIds?: string;
}

/** The only update type this adapter handles; also what the registration asks for. */
const ALLOWED_UPDATES = ["message"] as const;

/**
 * Waits between webhook registration attempts. A 429 waits for the
 * `retry_after` Telegram names instead, when that is longer.
 */
export const WEBHOOK_RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000];

/** A Bot API error code, when the error carries one (grammY's `GrammyError`). */
function telegramErrorCode(err: unknown): number | undefined {
  const code = (err as { error_code?: unknown } | null)?.error_code;
  return typeof code === "number" ? code : undefined;
}

function telegramRetryAfterMs(err: unknown): number {
  const seconds = (err as { parameters?: { retry_after?: unknown } } | null)?.parameters?.retry_after;
  return typeof seconds === "number" ? seconds * 1000 : 0;
}

export class TelegramAdapter implements ChannelAdapter {
  name = "telegram" as const;
  private bot: Bot | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  readonly webhookSecret: string;

  constructor(
    private readonly instanceId: InstanceSlug,
    private readonly cfg: TelegramConfig,
    private readonly webhookUrl: string,
  ) {
    this.webhookSecret = createHash("sha256").update(cfg.botToken).digest("hex");
  }

  async initialize(onMessage: MessageHandler): Promise<void> {
    const { botToken, allowedUserIds } = this.cfg;

    const allowedIds = allowedUserIds
      ?.split(",")
      .map((id) => id.trim())
      .filter(Boolean);

    this.bot = new Bot(botToken);

    /** Download a Telegram file by file_id and return its Buffer. */
    const downloadFile = async (fileId: string): Promise<Buffer | undefined> => {
      try {
        const file = await this.bot!.api.getFile(fileId);
        if (!file.file_path) return undefined;
        const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
        const res = await fetch(url);
        if (!res.ok) return undefined;
        return Buffer.from(await res.arrayBuffer());
      } catch (err) {
        console.error("Telegram file download failed (%s):", fileId, err);
        return undefined;
      }
    };

    /** Shared handler for messages that may have text and/or attachments. */
    const handleMessage = async (ctx: any) => {
      if (allowedIds?.length && !allowedIds.includes(String(ctx.from.id))) {
        return;
      }

      let text: string = ctx.message.text ?? ctx.message.caption ?? "";
      const attachments: Attachment[] = [];

      // Audio (voice note or audio file)
      const audioMetadataExtras: Record<string, unknown> = {};
      const voiceOrAudio = ctx.message.voice ?? ctx.message.audio;
      if (voiceOrAudio) {
        const data = await downloadFile(voiceOrAudio.file_id);
        if (!data) {
          await ctx.reply("I couldn't download the audio. Please try again.");
          return;
        }
        const mimeType: string =
          voiceOrAudio.mime_type ?? (ctx.message.voice ? "audio/ogg" : "audio/mpeg");
        const durationSec: number | undefined =
          typeof voiceOrAudio.duration === "number" ? voiceOrAudio.duration : undefined;

        const result = await transcribeAudio({
          audio: data,
          mimeType,
          durationSec,
          instanceSlug: this.instanceId,
          conversationId: `${this.instanceId}:telegram:${ctx.chat.id}`,
        });

        if (!result.ok) {
          await ctx.reply(result.userReply);
          return;
        }

        text = text ? `${text}\n${result.text}` : result.text;
        Object.assign(audioMetadataExtras, {
          audio: { ...result.metadata, latencyMs: result.latencyMs },
        });
      }

      // Photo: array of sizes, pick the largest
      if (ctx.message.photo?.length) {
        const largest = ctx.message.photo[ctx.message.photo.length - 1];
        const data = await downloadFile(largest.file_id);
        if (data) {
          attachments.push({ type: "image", data, mimeType: "image/jpeg", fileName: `photo_${largest.file_id}.jpg` });
        }
      }

      // Document (PDF, etc.)
      if (ctx.message.document) {
        const doc = ctx.message.document;
        const data = await downloadFile(doc.file_id);
        if (data) {
          const mimeType = doc.mime_type ?? "application/octet-stream";
          const isImage = mimeType.startsWith("image/");
          attachments.push({
            type: isImage ? "image" : "file",
            data,
            mimeType,
            fileName: doc.file_name ?? `document_${doc.file_id}`,
          });
        }
      }

      const response = await onMessage({
        channelType: "telegram",
        channelId: String(ctx.chat.id),
        instanceId: this.instanceId,
        userName: ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : ""),
        text,
        attachments: attachments.length > 0 ? attachments : undefined,
        metadata: {
          messageId: ctx.message.message_id,
          chatType: ctx.chat.type,
          ...(Object.keys(audioMetadataExtras).length > 0
            ? { originalKind: "audio", ...audioMetadataExtras }
            : {}),
        },
      });

      if (response.text) await this.sendFormatted(String(ctx.chat.id), response.text);
    };

    this.bot.on("message:text", handleMessage);
    this.bot.on("message:photo", handleMessage);
    this.bot.on("message:document", handleMessage);
    this.bot.on("message:voice", handleMessage);
    this.bot.on("message:audio", handleMessage);

    // A token Telegram refuses fails the start: that is a credential problem
    // only an administrator can fix, and the channel manager disables the
    // channel for it.
    await this.bot.init();
    // The webhook registration does not. A plain-HTTP base URL or a 429 during a
    // fleet restart used to fail the start the same way, and the channel stayed
    // disabled in the database until someone switched it back on by hand.
    void this.registerWebhook(this.bot, 0);
    console.log("Telegram bot started (webhook)");
  }

  /**
   * Point the bot's webhook at this deployment, retrying transient failures.
   * Telegram's `getWebhookInfo` shows the outcome — the URL it holds and its
   * last delivery error — so a failure here is visible from outside as well as
   * in the log.
   */
  private async registerWebhook(bot: Bot, attempt: number): Promise<void> {
    if (this.bot !== bot) return; // shut down or restarted meanwhile
    if (!this.webhookUrl.startsWith("https://")) {
      console.error(
        "[telegram] webhook not registered for %s: Telegram requires an HTTPS URL; set the platform base URL to https",
        this.instanceId,
      );
      return;
    }
    try {
      const info = await bot.api.getWebhookInfo();
      const allowed = info.allowed_updates ?? [];
      const current = info.url === this.webhookUrl &&
        allowed.length === ALLOWED_UPDATES.length && ALLOWED_UPDATES.every((u) => allowed.includes(u));
      if (!current) {
        await bot.api.setWebhook(this.webhookUrl, {
          secret_token: this.webhookSecret,
          allowed_updates: [...ALLOWED_UPDATES],
        });
      }
    } catch (err) {
      const code = telegramErrorCode(err);
      // A 4xx other than 429 is Telegram refusing the request itself: repeating it changes nothing.
      const retryable = code === undefined || code === 429 || code >= 500;
      const delay = WEBHOOK_RETRY_DELAYS_MS[attempt];
      if (!retryable || delay === undefined || this.bot !== bot) {
        console.error("[telegram] webhook registration failed for %s, giving up:", this.instanceId, err);
        return;
      }
      const wait = Math.max(delay, telegramRetryAfterMs(err));
      console.warn("[telegram] webhook registration failed for %s, retrying in %d ms:", this.instanceId, wait, err);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.registerWebhook(bot, attempt + 1);
      }, wait);
      this.retryTimer.unref?.();
    }
  }

  async handleInbound(update: Parameters<Bot["handleUpdate"]>[0]): Promise<void> {
    if (!this.bot) throw new Error("Telegram bot not initialized");
    await this.bot.handleUpdate(update);
  }

  async sendMessage(channelId: string, msg: OutgoingMessage): Promise<void> {
    if (!this.bot) throw new Error("Telegram bot not initialized");
    await this.sendFormatted(channelId, msg.text);
  }

  /**
   * Show the Telegram "typing…" indicator in the target chat. Auto-expires
   * after ~5s on Telegram's side, so the coordinator may re-invoke to keep
   * it visible during long pipeline runs.
   */
  async sendTyping(channelId: string): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.api.sendChatAction(channelId, "typing");
    } catch (err) {
      console.error("[telegram] sendChatAction failed for %s:", channelId, err);
    }
  }

  /**
   * Send with MarkdownV2, fallback to plain text if Telegram rejects the formatting.
   * Automatically splits long messages into multiple sends.
   */
  private async sendFormatted(chatId: string, text: string): Promise<void> {
    if (!this.bot) throw new Error("Telegram bot not initialized");

    const chunks = splitMessage(text, CHANNEL_MAX_LENGTH.telegram);
    for (const chunk of chunks) {
      try {
        const v2 = toTelegramMarkdownV2(chunk);
        await this.bot.api.sendMessage(chatId, v2, { parse_mode: "MarkdownV2" });
      } catch (err) {
        console.warn("[telegram] MarkdownV2 send failed, falling back to plain text:", err);
        await this.bot.api.sendMessage(chatId, chunk);
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.bot = null;
  }

  async deregister(): Promise<void> {
    if (this.bot) await this.bot.api.deleteWebhook();
  }
}
