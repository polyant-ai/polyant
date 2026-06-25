// SPDX-License-Identifier: AGPL-3.0-or-later

import { Bot } from "grammy";
import type { ChannelAdapter, Attachment, MessageHandler, OutgoingMessage } from "../../types.js";
import { CHANNEL_MAX_LENGTH } from "../../types.js";
import { toTelegramMarkdownV2 } from "./markdown-v2.js";
import { splitMessage } from "../../split-message.js";
import { transcribeAudio } from "../../audio-transcription.js";
import type { AgentSlug } from "../../../instances/identifiers.js";

export interface TelegramConfig {
  botToken: string;
  allowedUserIds?: string;
}

export class TelegramAdapter implements ChannelAdapter {
  name = "telegram" as const;
  private bot: Bot | null = null;

  constructor(
    private readonly agentId: AgentSlug,
    private readonly cfg: TelegramConfig,
  ) {}

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
          instanceSlug: this.agentId,
          conversationId: `${this.agentId}:telegram:${ctx.chat.id}`,
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
        agentId: this.agentId,
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

    // bot.init() validates the token (getMe) and resolves quickly.
    // bot.start() enters an infinite polling loop that never resolves — run fire-and-forget.
    await this.bot.init();
    this.bot.start().catch((err) =>
      console.error('Telegram polling error for instance "%s":', this.agentId, err),
    );
    console.log(`Telegram bot started for instance "${this.agentId}" (polling)`);
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
    if (this.bot) {
      this.bot.stop();
    }
  }
}

