// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { createSafeDispatcher, truncateBody, pickHeaders } from "../../utils/safe-http.js";
import { registerTool, type ToolContext } from "./registry.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BODY_SIZE = 16_384;

const INTERESTING_HEADERS = [
  "content-type",
  "content-length",
  "x-request-id",
  "x-ratelimit-remaining",
  "location",
];

/**
 * Walk an error's `cause` chain (Node 22 fetch nests the real failure inside
 * a generic `TypeError: fetch failed`) and produce a flat description.
 *
 * Returns:
 *  - message: the deepest cause's message — the actionable one to surface
 *  - code: error code from outer or deepest level (e.g. ENOTFOUND, ECONNREFUSED)
 *  - trace: full chain "OuterName: outer msg -> inner msg [code] -> ..."
 */
function describeFetchError(err: unknown): {
  message: string;
  code?: string;
  trace: string;
} {
  const top = err instanceof Error ? err : new Error(String(err));
  const formatNode = (e: Error): string => {
    const code = (e as { code?: string }).code;
    const head = e.name && e.name !== "Error" ? `${e.name}: ${e.message}` : e.message;
    return code ? `${head} [${code}]` : head;
  };

  const chain: string[] = [formatNode(top)];
  let current: unknown = (top as { cause?: unknown }).cause;
  let depth = 0;
  while (current && depth < 5) {
    if (current instanceof Error) {
      chain.push(formatNode(current));
      current = (current as { cause?: unknown }).cause;
    } else {
      chain.push(String(current));
      break;
    }
    depth += 1;
  }

  const deepest = chain[chain.length - 1];
  const message = deepest.replace(/\s*\[[A-Z_]+\]$/, "");
  const codeMatch = deepest.match(/\[([A-Z_]+)\]$/);
  const code = (top as { code?: string }).code ?? codeMatch?.[1];

  return {
    message,
    code,
    trace: chain.join(" -> "),
  };
}

registerTool({
  name: "httpRequest",
  description:
    "Execute an HTTP POST, PUT, PATCH or DELETE request to an external URL.\n" +
    "Use to integrate external systems via HTTP: webhooks, REST APIs, third-party services.\n" +
    "Auth is optional: pass authStyle 'bearer' or 'api-key' to inject the 'http_api_key' secret configured on the instance. " +
    "If authStyle is omitted or the secret is missing, the request is sent without auth (useful for public webhooks).\n" +
    "Do NOT pass credentials in the body or URL — auth is managed by instance secrets.\n" +
    "Internal/private URLs are blocked (SSRF protection). Timeout 15s.\n" +
    "For GET requests use the `curl` tool. Returns HTTP status, body, and relevant headers.",
  category: "integration",
  requiredSecrets: [
    {
      key: "http_api_key",
      type: "text",
      label: "HTTP API key",
      description:
        "Optional API key injected when 'authStyle' is set to 'bearer' or 'api-key'. Leave empty for unauthenticated calls.",
      optional: true,
    },
    {
      key: "http_allowed_domains",
      type: "text",
      sensitive: false,
      label: "HTTP allowed domains (allowlist)",
      description:
        "Optional comma-separated FQDN allowlist (e.g. 'api.example.com,hooks.partner.io'). When set, requests to any other hostname are blocked. Subdomains are allowed: an entry 'example.com' matches 'api.example.com' but NOT 'badexample.com'. Leave empty to allow any public host (SSRF gates still apply).",
      optional: true,
    },
  ],
  inputExamples: [
    {
      label: "POST JSON to a webhook with bearer auth",
      input: {
        url: "https://hooks.example.com/trigger",
        method: "POST",
        body: '{"event":"new_lead","name":"Jane Doe"}',
        authStyle: "bearer",
      },
    },
    {
      label: "PATCH partial update with api-key",
      input: {
        url: "https://api.example.com/items/123",
        method: "PATCH",
        body: '{"status":"completed"}',
        authStyle: "api-key",
      },
    },
    {
      label: "POST to a public webhook (no auth)",
      input: {
        url: "https://webhook.site/abc-123",
        method: "POST",
        body: '{"test":true}',
        authStyle: null,
      },
    },
  ],
  create: (ctx: ToolContext) => ({
    parameters: z.object({
      // NOTE: we don't use z.string().url() because Zod emits `"format": "uri"`
      // in the JSON Schema, and OpenAI strict-mode tool calling rejects the tool
      // before invoking it (InputValidationError on the LLM side). The
      // http://|https:// prefix is validated at runtime in execute().
      // See CLAUDE.md → "Important Caveats".
      url: z
        .string()
        .describe("Destination URL. Must start with http:// or https:// (validated at runtime)."),
      method: z
        .enum(["POST", "PUT", "PATCH", "DELETE"])
        .describe("HTTP method: POST, PUT, PATCH, or DELETE"),
      // NOTE: body is a SERIALIZED JSON STRING, not a Zod object. Reason:
      // OpenAI strict-mode rejects `additionalProperties: {}` (unbounded)
      // emitted by z.record(z.unknown()). Parsed at runtime in execute().
      // See CLAUDE.md → "Important Caveats" and strict-mode.test.ts.
      body: z
        .string()
        .describe(
          'JSON body to send, as a serialized string (e.g. \'{"event":"new_lead"}\'). Parsed at runtime.',
        ),
      authStyle: z
        .preprocess(
          (v) => {
            if (typeof v !== "string") return v;
            const normalized = v.trim().toLowerCase();
            return normalized === "" || normalized === "none" ? null : v;
          },
          z.enum(["bearer", "api-key"]).nullable(),
        )
        .describe(
          "Optional auth style. 'bearer' adds 'Authorization: Bearer <key>', " +
          "'api-key' adds 'X-API-Key: <key>'. Leave null/omitted (or 'none') for no authentication.",
        ),
    }),
    execute: async ({
      url,
      method,
      body,
      authStyle,
    }: {
      url: string;
      method: "POST" | "PUT" | "PATCH" | "DELETE";
      body: string;
      authStyle?: "bearer" | "api-key" | null;
    }) => {
      const apiKey = ctx.secrets?.["http_api_key"];
      const start = Date.now();

      // Runtime URL-prefix check (replaces Zod .url() — see note above).
      // Tools must not throw to the LLM: return a structured error object
      // consistent with the other error paths so the LLM can degrade/retry.
      if (!/^https?:\/\//i.test(url)) {
        return {
          error: "Invalid URL: must start with http:// or https://",
        };
      }

      // Runtime body parse (replaces z.record(z.unknown()) — see schema note).
      let requestBody: unknown;
      try {
        requestBody = JSON.parse(body);
      } catch {
        return {
          error: "Invalid body: not a valid JSON string",
        };
      }

      try {
        const targetUrl = new URL(url);

        // Per-instance domain allowlist (opt-in). If the secret is set,
        // the request hostname must match an entry. Matching is case-insensitive
        // and allows subdomain suffix match with a leading-dot guard:
        //   entry "example.com" matches "example.com" and "api.example.com",
        //   but NOT "badexample.com".
        const rawAllowedDomains = ctx.secrets?.["http_allowed_domains"]?.trim();
        if (rawAllowedDomains) {
          const allowed = rawAllowedDomains
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter((s) => s.length > 0);
          const host = targetUrl.hostname.toLowerCase();
          const isAllowed = allowed.some(
            (entry) => host === entry || host.endsWith(`.${entry}`),
          );
          if (!isAllowed) {
            ctx.audit.log({
              action: "integration.httpRequest",
              details: {
                url: targetUrl.toString(),
                method,
                decision: "blocked_by_allowlist",
              },
              success: false,
              error: "Hostname not in instance allowlist",
            });
            return { success: false, error: "Hostname not in instance allowlist" };
          }
        }

        // SSRF protection: block private/internal IPs, pin DNS
        const { dispatcher } = await createSafeDispatcher(targetUrl);

        // Build headers. Auth header is injected only when both authStyle and
        // the secret are present; otherwise the request goes out un-authenticated.
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        let authApplied: "bearer" | "api-key" | "none" = "none";
        if (authStyle === "api-key" && apiKey) {
          headers["X-API-Key"] = apiKey;
          authApplied = "api-key";
        } else if (authStyle === "bearer" && apiKey) {
          headers["Authorization"] = `Bearer ${apiKey}`;
          authApplied = "bearer";
        }

        const response = await fetch(targetUrl.toString(), {
          method,
          headers,
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
          // @ts-expect-error -- Node 22 fetch supports undici dispatcher option
          dispatcher,
        });

        const rawBody = await response.text();
        const { body: trimmedBody, truncated } = truncateBody(rawBody, MAX_BODY_SIZE);

        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(trimmedBody);
        } catch {
          parsedBody = trimmedBody;
        }

        const responseHeaders = pickHeaders(response.headers, INTERESTING_HEADERS);
        const durationMs = Date.now() - start;

        ctx.audit.log({
          action: "integration.httpRequest",
          details: {
            url: targetUrl.toString(),
            method,
            statusCode: response.status,
            authApplied,
            durationMs,
          },
          success: response.ok,
          ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
        });

        return {
          status: response.status,
          body: parsedBody,
          headers: responseHeaders,
          truncated,
          durationMs,
        };
      } catch (err) {
        const durationMs = Date.now() - start;
        // Node 22 fetch wraps the real failure in `err.cause` — extract the
        // actionable cause + full trace for observability (DNS, ECONNREFUSED,
        // TLS, AbortError, ...).
        const detail = describeFetchError(err);
        console.error(
          `httpRequest tool error [${method} ${url}]: ${detail.trace}`,
        );
        ctx.audit.log({
          action: "integration.httpRequest",
          details: {
            url,
            method,
            durationMs,
            errorCode: detail.code,
            trace: detail.trace,
          },
          success: false,
          error: detail.message,
        });
        return {
          error: detail.message,
          ...(detail.code ? { errorCode: detail.code } : {}),
          cause: detail.trace,
        };
      }
    },
  }),
});
