// SPDX-License-Identifier: AGPL-3.0-or-later

import { AsyncLocalStorage } from "node:async_hooks";
import Twilio from "twilio";
import { splitMessage } from "../../split-message.js";
import { CHANNEL_MAX_LENGTH } from "../../types.js";
import type { TemplateDefinition } from "./render-template.js";

const TYPING_INDICATOR_ENDPOINT = "https://messaging.twilio.com/v2/Indicators/Typing.json";
const CONTENT_API_ENDPOINT = "https://content.twilio.com/v1/Content";

/** Waits before the second and third attempt of a send Twilio did not take. */
const SEND_RETRY_DELAYS_MS = [300, 1_200];
/** The longest wait a `Retry-After` may ask for; past it the send fails at once. */
const SEND_RETRY_MAX_WAIT_MS = 5_000;

/**
 * Network errors raised before any byte of the request left: the message
 * cannot have reached Twilio. A reset, a TLS failure or a timeout is left out,
 * since the library does not tell whether the request was already sent.
 */
const NOT_SENT_ERROR_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]);

/**
 * A send Twilio certainly did not take: rate-limited (429), refused as
 * unavailable (503), or never reached. The Messages API takes no idempotency
 * key, so anything else (500, 502, 504, a read timeout, a reset after sending)
 * may have queued the message, and a resend would deliver it twice: those fail
 * as before, visibly.
 */
function isNotTakenSendError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number") return status === 429 || status === 503;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && NOT_SENT_ERROR_CODES.has(code);
}

/**
 * The SDK's error carries no headers, so the `Retry-After` of the attempt
 * running in this async context is noted by the HTTP client as it answers.
 */
const attemptRetryAfter = new AsyncLocalStorage<{ ms?: number }>();

/** `Retry-After` in milliseconds: delta-seconds or an HTTP date. */
function parseRetryAfterMs(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** The SDK's HTTP client, noting each answer's `Retry-After` for the attempt that made it. */
function retryAfterNotingHttpClient(): InstanceType<typeof Twilio.RequestClient> {
  const client = new Twilio.RequestClient();
  const request = client.request.bind(client);
  client.request = async (opts) => {
    const response = await request(opts);
    const noted = attemptRetryAfter.getStore();
    if (noted) noted.ms = parseRetryAfterMs(response.headers?.["retry-after"]);
    return response;
  };
  return client;
}

async function withSendRetry<T>(send: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const noted: { ms?: number } = {};
    try {
      return await attemptRetryAfter.run(noted, send);
    } catch (err) {
      const delay = SEND_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isNotTakenSendError(err)) throw err;
      const wait = Math.max(delay, noted.ms ?? 0);
      if (wait > SEND_RETRY_MAX_WAIT_MS) throw err;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

/**
 * The two credential shapes Twilio accepts for one account. `apiKey` is a
 * revocable key pair; it can drive every REST call but CANNOT validate an
 * inbound webhook signature, which Twilio keys on the account Auth Token.
 */
export type TwilioCredentials =
  | { mode: "authToken"; accountSid: string; authToken: string }
  | { mode: "apiKey"; accountSid: string; apiKeySid: string; apiKeySecret: string };

export class TwilioWhatsAppClient {
  private readonly client: ReturnType<typeof Twilio>;
  private readonly credentials: TwilioCredentials;
  private readonly fromNumber: string;
  /**
   * In-memory cache of resolved template definitions, keyed by contentSid.
   * Approved WhatsApp templates are immutable post-approval, so a process-
   * lifetime cache is safe. Errors are NOT cached (transient failures must
   * not pin a missing template).
   */
  private readonly templateCache = new Map<string, TemplateDefinition>();

  private constructor(credentials: TwilioCredentials, whatsappNumber: string) {
    this.client =
      credentials.mode === "apiKey"
        ? // An API Key SID goes in the username slot; the SDK needs the account
          // separately because it builds `/Accounts/{AC…}/…` REST paths and
          // rejects any username-derived SID that does not start with `AC`.
          Twilio(credentials.apiKeySid, credentials.apiKeySecret, {
            accountSid: credentials.accountSid,
            httpClient: retryAfterNotingHttpClient(),
          })
        : Twilio(credentials.accountSid, credentials.authToken, { httpClient: retryAfterNotingHttpClient() });
    this.credentials = credentials;
    this.fromNumber = whatsappNumber;
  }

  static create(credentials: TwilioCredentials, whatsappNumber: string): TwilioWhatsAppClient {
    if (!credentials.accountSid) throw new Error("accountSid is required");
    if (credentials.mode === "apiKey") {
      if (!credentials.apiKeySid) throw new Error("apiKeySid is required");
      if (!credentials.apiKeySecret) throw new Error("apiKeySecret is required");
    } else if (!credentials.authToken) {
      throw new Error("authToken is required");
    }
    if (!/^\+\d+$/.test(whatsappNumber)) throw new Error("whatsappNumber must start with + followed by digits");
    return new TwilioWhatsAppClient(credentials, whatsappNumber);
  }

  /**
   * Base64 `user:pass` for the endpoints called with `fetch` rather than through
   * the SDK (typing indicator, Content API, media download), so the credential
   * mode is resolved in a single place.
   *
   * Two accessors because the consumers differ: `media-fetch.ts` prefixes
   * `Basic ` itself and needs the bare value.
   */
  basicAuthValue(): string {
    const [user, pass] =
      this.credentials.mode === "apiKey"
        ? [this.credentials.apiKeySid, this.credentials.apiKeySecret]
        : [this.credentials.accountSid, this.credentials.authToken];
    return Buffer.from(`${user}:${pass}`).toString("base64");
  }

  basicAuthHeader(): string {
    return `Basic ${this.basicAuthValue()}`;
  }

  async sendMessage(to: string, body: string, opts?: { mediaUrl?: string[] }): Promise<void> {
    const cleanTo = to.replace(/^whatsapp:/, "");
    const chunks = body.length > 0 ? splitMessage(body, CHANNEL_MAX_LENGTH.whatsapp) : [""];
    const mediaUrl = opts?.mediaUrl?.length ? opts.mediaUrl : undefined;

    // Each chunk is retried on its own, so a transient failure in the middle
    // neither loses the rest nor resends the chunks already delivered.
    for (let i = 0; i < chunks.length; i++) {
      const isFirst = i === 0;
      await withSendRetry(() =>
        this.client.messages.create({
          from: `whatsapp:${this.fromNumber}`,
          to: `whatsapp:${cleanTo}`,
          body: chunks[i],
          // Media goes with the first chunk only to avoid duplicate deliveries.
          ...(isFirst && mediaUrl ? { mediaUrl } : {}),
        }),
      );
    }
  }

  async sendTemplate(
    to: string,
    contentSid: string,
    variables: Record<string, string>,
  ): Promise<string> {
    const cleanTo = to.replace(/^whatsapp:/, "");
    const res = await withSendRetry(() =>
      this.client.messages.create({
        from: `whatsapp:${this.fromNumber}`,
        to: `whatsapp:${cleanTo}`,
        contentSid,
        contentVariables: JSON.stringify(variables),
      }),
    );
    return res.sid;
  }

  /**
   * Send a WhatsApp typing indicator in response to an inbound message.
   *
   * The indicator auto-expires after 25s or when the outbound reply is
   * delivered (whichever comes first). As a documented side-effect, this
   * call also marks the referenced message as "read" on the user's client
   * (double blue check).
   *
   * @param messageSid Twilio SID of the inbound message (SM... or MM...).
   * @see https://www.twilio.com/docs/whatsapp/api/typing-indicators-resource
   */
  async sendTypingIndicator(messageSid: string): Promise<void> {
    if (!messageSid) throw new Error("messageSid is required");

    const body = new URLSearchParams({ messageId: messageSid, channel: "whatsapp" });

    const res = await fetch(TYPING_INDICATOR_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: this.basicAuthHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      throw new Error(`Twilio typing indicator failed (${res.status})`);
    }
  }

  /**
   * Validate an inbound webhook signature. Twilio computes it as HMAC-SHA1
   * keyed with the account Auth Token and publishes no API-Key-keyed variant,
   * so this is structurally unavailable in `apiKey` mode — that mode
   * authenticates inbound with a path secret instead (see the Twilio webhook
   * controller). Throwing here rather than returning false keeps a
   * misconfiguration loud instead of silently rejecting every message.
   */
  validateWebhook(signature: string, url: string, params: Record<string, string>): boolean {
    if (this.credentials.mode !== "authToken") {
      throw new Error("Signature validation requires an auth token; this channel uses an API key");
    }
    return Twilio.validateRequest(this.credentials.authToken, signature, url, params);
  }

  /**
   * Fetch the approved template definition from the Twilio Content API and
   * normalize it for conversation-history rendering. Cached per process for
   * the lifetime of this client.
   *
   * Endpoint: `GET https://content.twilio.com/v1/Content/{ContentSid}`.
   * Response shape contains a `types` map keyed by content type
   * (`twilio/text`, `twilio/quick-reply`, `twilio/call-to-action`,
   * `twilio/card`). Each variant carries a `body` (with `{{N}}` placeholders)
   * and optional `actions` for buttons/CTAs/list items.
   *
   * @see https://www.twilio.com/docs/content/api/content-resource
   */
  async getTemplateContent(contentSid: string): Promise<TemplateDefinition> {
    if (!contentSid) throw new Error("contentSid is required");

    const cached = this.templateCache.get(contentSid);
    if (cached) return cached;

    const res = await fetch(`${CONTENT_API_ENDPOINT}/${encodeURIComponent(contentSid)}`, {
      method: "GET",
      headers: {
        Authorization: this.basicAuthHeader(),
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`Twilio Content API ${res.status}${errBody ? `: ${errBody}` : ""}`);
    }

    const json = (await res.json()) as TwilioContentResponse;
    const definition = parseContentDefinition(json);
    if (!definition) {
      throw new Error(`Twilio Content ${contentSid} has no renderable body`);
    }

    this.templateCache.set(contentSid, definition);
    return definition;
  }
}

/**
 * Subset of the Twilio Content API response schema we care about. The full
 * response also carries metadata (sid, friendlyName, language, …) and other
 * channel-specific types — we only extract what we need to render a body
 * for conversation history.
 */
type TwilioContentResponse = {
  sid?: string;
  types?: Record<string, TwilioContentType | undefined>;
};

type TwilioContentType = {
  body?: string;
  // Quick-reply / call-to-action / list-picker actions all carry a `title`
  // (display label) plus type-specific fields. We only persist the label.
  actions?: { title?: string }[];
  items?: { item?: string }[];
};

/**
 * Pick the most representative content type and normalize it. Order of
 * preference: text → quick-reply → call-to-action → card → list-picker.
 * Returns `null` if no variant has a usable body.
 */
function parseContentDefinition(res: TwilioContentResponse): TemplateDefinition | null {
  const types = res.types ?? {};
  const order = [
    "twilio/text",
    "twilio/quick-reply",
    "twilio/call-to-action",
    "twilio/card",
    "twilio/list-picker",
  ];

  for (const key of order) {
    const candidate = types[key];
    if (!candidate || !candidate.body) continue;

    const labels = collectActionLabels(candidate);
    return {
      body: candidate.body,
      ...(labels.length > 0 ? { actions: labels.map((label) => ({ label })) } : {}),
    };
  }

  return null;
}

function collectActionLabels(t: TwilioContentType): string[] {
  const labels: string[] = [];
  for (const a of t.actions ?? []) {
    if (a.title) labels.push(a.title);
  }
  for (const i of t.items ?? []) {
    if (i.item) labels.push(i.item);
  }
  return labels;
}

