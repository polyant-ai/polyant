// SPDX-License-Identifier: AGPL-3.0-or-later

import { TwilioWhatsAppClient } from "./twilio-client.js";
import { toWhatsAppText } from "./whatsapp-format.js";
import { renderTemplateBody } from "./render-template.js";
import type { ChannelAdapter, Attachment, MessageHandler, OutgoingMessage } from "../../types.js";
import { transcribeAudio } from "../../audio-transcription.js";
import { createSafeDispatcher } from "../../../utils/safe-http.js";

export interface WhatsAppConfig {
  accountSid: string;
  authToken: string;
  whatsappNumber: string;
}

export class WhatsAppAdapter implements ChannelAdapter {
  name = "whatsapp" as const;
  private client: TwilioWhatsAppClient | null = null;
  private onMessage: MessageHandler | null = null;

  constructor(
    private readonly instanceSlug: string,
    private readonly cfg: WhatsAppConfig,
  ) {}

  async initialize(onMessage: MessageHandler): Promise<void> {
    this.client = TwilioWhatsAppClient.create(
      this.cfg.accountSid,
      this.cfg.authToken,
      this.cfg.whatsappNumber,
    );
    this.onMessage = onMessage;
    console.log(`WhatsApp (Twilio) adapter initialized for instance "${this.instanceSlug}"`);
  }

  /** Called by the webhook controller when an inbound message arrives. */
  async handleInbound(params: {
    from: string;
    body: string;
    profileName?: string;
    messageSid: string;
    instanceId: string;
    media?: Array<{ url: string; contentType: string }>;
  }): Promise<string> {
    if (!this.onMessage) throw new Error("WhatsApp adapter not initialized");

    // Note: typing indicator is NOT fired here. The coordinator (MessageCoordinator)
    // schedules it via the channel's `sendTyping(channelId, messageSid)` method
    // after a human-like delay, coherent with cancel-and-restart semantics.

    // Download media attachments from Twilio, split audio vs non-audio
    let attachments: Attachment[] | undefined;
    let body = params.body;
    const audioMetadataExtras: Record<string, unknown> = {};

    if (params.media?.length) {
      const downloaded = await Promise.all(
        params.media.map((m) => this.downloadMedia(m.url, m.contentType)),
      );
      const valid = downloaded.filter((a): a is Attachment => a != null);

      const audios = valid.filter((a) => (a.mimeType ?? "").startsWith("audio/"));
      const nonAudios = valid.filter((a) => !(a.mimeType ?? "").startsWith("audio/"));

      const transcripts: string[] = [];
      for (const a of audios) {
        if (!a.data) continue;
        const result = await transcribeAudio({
          audio: a.data,
          mimeType: a.mimeType ?? "audio/ogg",
          instanceSlug: this.instanceSlug,
          conversationId: `${params.instanceId}:whatsapp:${params.from}`,
        });
        if (!result.ok) {
          await this.sendMessage(params.from, { text: result.userReply });
          return result.userReply;
        }
        transcripts.push(result.text);
        Object.assign(audioMetadataExtras, {
          audio: { ...result.metadata, latencyMs: result.latencyMs },
        });
      }

      if (transcripts.length > 0) {
        body = body ? [body, ...transcripts].join("\n") : transcripts.join("\n");
      }
      if (nonAudios.length > 0) attachments = nonAudios;
    }

    const response = await this.onMessage({
      channelType: "whatsapp",
      channelId: params.from,
      instanceId: params.instanceId,
      userName: params.profileName || params.from,
      text: body,
      attachments,
      metadata: {
        messageSid: params.messageSid,
        ...(Object.keys(audioMetadataExtras).length > 0
          ? { originalKind: "audio", ...audioMetadataExtras }
          : {}),
      },
    });

    if (response.text) {
      await this.sendMessage(params.from, response);
    }

    return response.text;
  }

  /** Download a Twilio media file using Basic auth. */
  private async downloadMedia(url: string, contentType: string): Promise<Attachment | null> {
    try {
      // SSRF protection: Twilio media URLs are user-influenced upstream. Run the same
      // safe-dispatcher gate used by httpRequest/curl tools — blocks private IPs +
      // pins DNS to the validated address (no rebinding TOCTOU). If the URL fails
      // the safety check, skip the attachment rather than throwing.
      let targetUrl: URL;
      try {
        targetUrl = new URL(url);
      } catch {
        console.warn("[whatsapp] Media URL is not a valid URL, skipping: %s", url);
        return null;
      }
      let dispatcher: unknown;
      try {
        ({ dispatcher } = await createSafeDispatcher(targetUrl));
      } catch (err) {
        console.warn(
          "[whatsapp] Media URL failed SSRF check, skipping (%s): %s",
          url,
          err instanceof Error ? err.message : String(err),
        );
        return null;
      }

      const auth = Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString("base64");
      const res = await fetch(targetUrl.toString(), {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(30_000),
        // @ts-expect-error -- Node 22 fetch supports undici dispatcher option
        dispatcher,
      });
      if (!res.ok) return null;
      const data = Buffer.from(await res.arrayBuffer());
      const isImage = contentType.startsWith("image/");
      // Extract filename from URL (last path segment before query)
      const urlPath = targetUrl.pathname;
      const fileName = urlPath.split("/").pop() ?? undefined;
      return {
        type: isImage ? "image" : "file",
        data,
        mimeType: contentType,
        fileName,
      };
    } catch (err) {
      console.error("[whatsapp] Media download failed (%s):", url, err);
      return null;
    }
  }

  async sendMessage(channelId: string, msg: OutgoingMessage): Promise<void> {
    if (!this.client) throw new Error("WhatsApp adapter not initialized");
    let body = msg.text;
    try {
      body = toWhatsAppText(msg.text);
    } catch (err) {
      // Formatting failed — fall back to the raw text so the message is never lost
      console.warn(`[whatsapp] Markdown conversion failed, sending raw text:`, err);
    }
    const mediaUrl = Array.isArray(msg.mediaUrl)
      ? msg.mediaUrl
      : msg.mediaUrl
        ? [msg.mediaUrl]
        : undefined;
    await this.client.sendMessage(channelId, body, mediaUrl ? { mediaUrl } : undefined);
  }

  async sendTemplate(
    channelId: string,
    contentSid: string,
    variables: Record<string, string>,
  ): Promise<string> {
    if (!this.client) throw new Error("WhatsApp adapter not initialized");
    return this.client.sendTemplate(channelId, contentSid, variables);
  }

  /**
   * Resolve the rendered template body for conversation history. Calls the
   * Twilio Content API (cached per process) to fetch the approved template
   * definition, then substitutes the supplied variables.
   */
  async getTemplateBody(
    contentSid: string,
    variables: Record<string, string>,
  ): Promise<string> {
    if (!this.client) throw new Error("WhatsApp adapter not initialized");
    const definition = await this.client.getTemplateContent(contentSid);
    return renderTemplateBody(definition, variables);
  }

  /**
   * Signal "typing…" on the user's WhatsApp client. Requires the Twilio SID
   * of a recent inbound message — the API refuses without it. No-op if the
   * adapter is not yet initialized or the SID is missing.
   */
  async sendTyping(_channelId: string, messageSid?: string): Promise<void> {
    if (!this.client || !messageSid) return;
    try {
      await this.client.sendTypingIndicator(messageSid);
    } catch (err) {
      console.error("[whatsapp] Typing indicator failed for %s:", messageSid, err);
    }
  }

  async shutdown(): Promise<void> {
    this.client = null;
    this.onMessage = null;
  }

  /** Validate a Twilio webhook signature. */
  validateSignature(signature: string, url: string, params: Record<string, string>): boolean {
    if (!this.client) return false;
    return this.client.validateWebhook(signature, url, params);
  }
}
