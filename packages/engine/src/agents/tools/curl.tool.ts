// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";
import { createSafeDispatcher, truncateBody, pickHeaders } from "../../utils/safe-http.js";
import { errMsg } from "../../utils/error.js";

const DEFAULT_MAX_BODY_SIZE = 16_384;
const DEFAULT_TIMEOUT_MS = 15_000;

/** Headers that could be abused for SSRF or host-header poisoning — stripped from user input. */
const FORBIDDEN_HEADERS = new Set(["host", "x-forwarded-for", "x-forwarded-host", "x-original-url", "x-real-ip"]);

const INTERESTING_HEADERS = [
  "content-type",
  "content-length",
  "content-encoding",
  "cache-control",
  "etag",
  "last-modified",
  "location",
  "x-ratelimit-remaining",
];

export default defineTool({
  name: "curl",
  description:
    "Execute an HTTP GET request to a specified URL.\n" +
    "Use to fetch content from known URLs: web pages, REST APIs, JSON files, RSS feeds.\n" +
    "Do NOT use for general information searches — use `webSearch` instead.\n" +
    "Returns the HTTP status, relevant headers, and body (truncated to `maxBodySize`).\n" +
    "Caveat: GET only, no POST/PUT. Internal/private URLs are blocked (SSRF protection). Default timeout 15s.",
  category: "research",
  inputExamples: [
    {
      label: "Simple GET",
      input: { url: "https://api.example.com/data", headers: null, queryParams: null, maxBodySize: null, timeoutMs: null },
    },
    {
      label: "GET with Authorization header",
      input: { url: "https://api.example.com/protected", headers: { "Authorization": "Bearer token123" }, queryParams: { "page": "1" }, maxBodySize: null, timeoutMs: null },
    },
  ],
  parameters: z.object({
      url: z
        .string()
        .describe("Full URL to request (must start with `http://` or `https://`)."),
      headers: z
        .record(z.string())
        .nullable()
        .describe(
          "HTTP headers to send with the request (e.g. Authorization, Accept). Pass null if not needed.",
        ),
      queryParams: z
        .record(z.string())
        .nullable()
        .describe("Query parameters to append to the URL. Pass null if not needed."),
      maxBodySize: z
        .number()
        .nullable()
        .describe(
          `Maximum number of characters to return from the body (default: ${DEFAULT_MAX_BODY_SIZE}). Pass null for the default.`,
        ),
      timeoutMs: z
        .number()
        .nullable()
        .describe(
          `Request timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS}). Pass null for the default.`,
        ),
    }),
  execute: async ({ url, headers, queryParams, maxBodySize, timeoutMs }: { url: string; headers: Record<string, string> | null; queryParams: Record<string, string> | null; maxBodySize: number | null; timeoutMs: number | null }, ctx) => {
      const limit = maxBodySize ?? DEFAULT_MAX_BODY_SIZE;
      const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;

      try {
        const targetUrl = new URL(url);
        if (queryParams) {
          for (const [key, value] of Object.entries(queryParams)) {
            targetUrl.searchParams.append(key, value);
          }
        }

        // Strip dangerous headers that could be used for SSRF or host-header poisoning
        const safeHeaders = Object.fromEntries(
          Object.entries(headers ?? {}).filter(([k]) => !FORBIDDEN_HEADERS.has(k.toLowerCase())),
        );

        // SSRF protection: block private/internal IPs, pin DNS
        const { dispatcher } = await createSafeDispatcher(targetUrl);

        const response = await fetch(targetUrl.toString(), {
          method: "GET",
          headers: safeHeaders,
          signal: AbortSignal.timeout(timeout),
          // @ts-expect-error -- Node 22 fetch supports undici dispatcher option
          dispatcher,
        });

        const rawBody = await response.text();
        const { body: trimmedBody, truncated } = truncateBody(rawBody, limit);
        const responseHeaders = pickHeaders(response.headers, INTERESTING_HEADERS);

        ctx.audit.log({
          action: "web.fetch",
          details: {
            url: targetUrl.toString(),
            method: "GET",
            statusCode: response.status,
            contentLength: rawBody.length,
          },
          success: true,
        });

        return {
          url: targetUrl.toString(),
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          body: trimmedBody,
          truncated,
          bodyLength: rawBody.length,
        };
      } catch (err) {
        const message = errMsg(err);
        console.error(`curl tool error: ${message}`);
        ctx.audit.log({
          action: "web.fetch",
          details: { url, method: "GET" },
          success: false,
          error: message,
        });
        return {
          url,
          status: null,
          statusText: null,
          headers: {},
          body: null,
          truncated: false,
          bodyLength: 0,
          error: message,
        };
      }
  },
});
