// SPDX-License-Identifier: AGPL-3.0-or-later

import { TwilioWhatsAppClient } from "./twilio-client.js";
import { toWhatsAppText } from "./whatsapp-format.js";
import { renderTemplateBody } from "./render-template.js";
import type { ChannelAdapter, Attachment, MessageHandler, OutboundDelivery, OutgoingMessage } from "../../types.js";
import { contactChannelId } from "../../outbound-conversation.js";
import { transcribeInbound } from "../../audio-transcription.js";
import { fetchMediaFollowingRedirects } from "./media-fetch.js";
import type { InstanceSlug } from "../../../instances/identifiers.js";
import { resolveTwilioCredentials, type WhatsAppConfig } from "./resolve-credentials.js";
import { contactConversationId } from "../../outbound-conversation.js";
import { createLogger } from "../../../utils/create-logger.js";
import { errMsg } from "../../../utils/error.js";

const log = createLogger();

export type { WhatsAppConfig };

export class WhatsAppAdapter implements ChannelAdapter {
  name = "whatsapp" as const;
  private client: TwilioWhatsAppClient | null = null;
  private onMessage: MessageHandler | null = null;

  constructor(
    private readonly instanceSlug: InstanceSlug,
    private readonly cfg: WhatsAppConfig,
  ) {}

  async initialize(onMessage: MessageHandler): Promise<void> {
    this.client = TwilioWhatsAppClient.create(
      resolveTwilioCredentials(this.cfg),
      this.cfg.whatsappNumber,
    );
    this.onMessage = onMessage;
    log.info("whatsapp", `Twilio adapter initialized for instance "${this.instanceSlug}"`);
  }

  /** Called by the webhook controller when an inbound message arrives. */
  async handleInbound(params: {
    from: string;
    body: string;
    profileName?: string;
    messageSid: string;
    instanceId: InstanceSlug;
    media?: Array<{ url: string; contentType: string }>;
  }): Promise<string> {
    if (!this.onMessage) throw new Error("WhatsApp adapter not initialized");

    // Note: typing indicator is NOT fired here. The coordinator (MessageCoordinator)
    // schedules it via the channel's `sendTyping(channelId, messageSid)` method
    // after a human-like delay, coherent with cancel-and-restart semantics.

    // Download media attachments from Twilio, split audio vs non-audio
    let attachments: Attachment[] | undefined;
    let body = params.body;
    let audioMetadata: Record<string, unknown> | undefined;

    if (params.media?.length) {
      const downloaded = await Promise.all(
        params.media.map((m) => this.downloadMedia(m.url, m.contentType)),
      );
      const valid = downloaded.filter((a): a is Attachment => a != null);

      const audios = valid.filter((a) => (a.mimeType ?? "").startsWith("audio/"));
      const nonAudios = valid.filter((a) => !(a.mimeType ?? "").startsWith("audio/"));

      if (audios.length > 0) {
        const transcribed = await transcribeInbound({
          instanceSlug: this.instanceSlug,
          conversationId: contactConversationId(params.instanceId, "whatsapp", params.from),
          text: body,
          clips: audios.flatMap((a) => (a.data ? [{ audio: a.data, mimeType: a.mimeType ?? "audio/ogg" }] : [])),
        });
        if (!transcribed.ok) {
          await this.sendMessage(params.from, { text: transcribed.reply });
          return transcribed.reply;
        }
        body = transcribed.text;
        audioMetadata = transcribed.metadata;
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
        ...audioMetadata,
      },
    });

    if (response.text) {
      await this.sendMessage(params.from, response);
    }

    return response.text;
  }

  /**
   * Download a Twilio media file using Basic auth. The fetch follows Twilio's cross-host
   * 302 redirect (api.twilio.com → media CDN) while re-validating SSRF on every hop —
   * see fetchMediaFollowingRedirects. Returns null (skip the attachment) on any failure.
   */
  private async downloadMedia(url: string, contentType: string): Promise<Attachment | null> {
    try {
      if (!this.client) return null;
      const res = await fetchMediaFollowingRedirects(url, this.client.basicAuthValue());
      if (!res || !res.ok) return null;
      const data = Buffer.from(await res.arrayBuffer());
      const isImage = contentType.startsWith("image/");
      // Filename from the original media URL (last path segment).
      let fileName: string | undefined;
      try {
        fileName = new URL(url).pathname.split("/").pop() || undefined;
      } catch {
        fileName = undefined;
      }
      return { type: isImage ? "image" : "file", data, mimeType: contentType, fileName };
    } catch (err) {
      log.error("whatsapp", `Media download failed (${url})`, err);
      return null;
    }
  }

  async sendMessage(channelId: string, msg: OutgoingMessage): Promise<OutboundDelivery> {
    if (!this.client) throw new Error("WhatsApp adapter not initialized");
    let body = msg.text;
    try {
      body = toWhatsAppText(msg.text);
    } catch (err) {
      // Formatting failed — fall back to the raw text so the message is never lost
      log.warn("whatsapp", `Markdown conversion failed, sending raw text: ${errMsg(err)}`);
    }
    const mediaUrl = Array.isArray(msg.mediaUrl)
      ? msg.mediaUrl
      : msg.mediaUrl
        ? [msg.mediaUrl]
        : undefined;
    await this.client.sendMessage(channelId, body, mediaUrl ? { mediaUrl } : undefined);
    return { channelId: contactChannelId("whatsapp", channelId) };
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
      log.error("whatsapp", `Typing indicator failed for ${messageSid}`, err);
    }
  }

  async shutdown(): Promise<void> {
    this.client = null;
    this.onMessage = null;
  }

  /** Validate a Twilio webhook signature. Returns false when this channel uses
   *  an API key, which cannot validate signatures — the webhook controller
   *  routes those channels to the path-secret gate instead and never calls
   *  this. */
  validateSignature(signature: string, url: string, params: Record<string, string>): boolean {
    if (!this.client) return false;
    try {
      return this.client.validateWebhook(signature, url, params);
    } catch (err) {
      // `validateWebhook` throws deliberately when this channel is in `apiKey`
      // mode (expected — the webhook controller should not have called this
      // path at all). Anything else is an unexpected internal failure (e.g. a
      // malformed url/params making the Twilio SDK throw) and must be
      // distinguishable from a forged-signature `false`, or the operator has
      // no way to tell "attack" apart from "broken code". Never log
      // credential material — only the error message.
      const isWrongModeError = err instanceof Error && /auth token/i.test(err.message);
      if (isWrongModeError) {
        log.warn("whatsapp", `Signature validation skipped: ${err.message}`);
      } else {
        log.error("whatsapp", "Signature validation threw unexpectedly", err);
      }
      return false;
    }
  }
}
