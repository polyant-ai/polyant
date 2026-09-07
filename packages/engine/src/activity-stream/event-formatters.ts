// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure formatters for ActivityBus events. Extracted from the legacy
 * polling source (`real-events.ts`, removed) so the same PII-safe
 * argument summarisation and reasoning condensation are reused by:
 *   - the live ActivityBus tap on AI gateway streams
 *   - the non-streaming batch emitter that fires after `chat()` resolves
 *   - any historical/migration tool that still wants a one-shot view
 *
 * Everything in this file is intentionally side-effect-free and trivially
 * unit-testable — the bus orchestration lives in `bus-emitter.ts`.
 */

import type { ReasoningDetail } from "../conversations/schema.js";

export const MAX_REASONING_CHARS = 240;
export const REDACTED_PLACEHOLDER = "[ragionamento interno protetto]";

/**
 * Concatenate reasoning blocks into a single string, redacted-aware,
 * untruncated. Callers downstream apply the cap they need (compact list
 * row vs full-detail spotlight panel).
 */
export function joinReasoning(blocks: ReasoningDetail[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "redacted") {
      parts.push(REDACTED_PLACEHOLDER);
    } else if (b.type === "text" && b.text) {
      parts.push(b.text);
    }
  }
  return parts.join(" ").trim();
}

/** Aggregate the per-step reasoning blocks into a short, displayable teaser. */
export function formatReasoning(blocks: ReasoningDetail[]): string {
  return truncate(joinReasoning(blocks), MAX_REASONING_CHARS);
}

/**
 * Produce a short human-readable teaser of tool args. Never serialises args
 * verbatim — strict allow-list per known tool, falls back to a key list.
 *
 * Keep this in sync with the audit logger's redaction rules.
 */
export function summarizeArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;

  switch (toolName) {
    case "hubspotContact": {
      const parts = [
        str(a.action),
        str(a.firstName),
        str(a.lastName),
      ].filter(Boolean);
      return truncate(parts.join(" "), 80);
    }
    case "hubspotDeal":
      return truncate([str(a.action), str(a.dealName)].filter(Boolean).join(" "), 80);
    case "hubspotTicket":
      return truncate([str(a.action), str(a.subject)].filter(Boolean).join(" "), 80);
    case "hubspotNote":
      return truncate([str(a.action), str(a.contactId), str(a.dealId)].filter(Boolean).join(" "), 80);
    case "hubspotSendEmail":
      return truncate(str(a.subject) ?? "", 80);
    case "hubspotCreateTask":
      return truncate(str(a.subject) ?? "", 80);
    case "hubspotMeeting":
      return truncate([str(a.action), str(a.title)].filter(Boolean).join(" "), 80);
    case "hubspotGetCompany":
      return truncate(str(a.name) ?? str(a.domain) ?? "", 80);
    case "searchKnowledge":
    case "searchMemory":
    case "webSearch":
      return truncate(str(a.query) ?? "", 80);
    case "scheduleTask":
      return truncate(str(a.subject) ?? str(a.action) ?? "", 80);

    // ── Dev / lifecycle tools — values are paths, slugs, repos, urls. Safe
    //    to display verbatim (no PII).
    case "gitCloneRepo":
      return truncate(str(a.repo) ?? str(a.url) ?? "", 80);
    case "listDirectory":
    case "readFile":
    case "writeFile":
      return truncate(str(a.path) ?? "", 80);
    case "readSkill":
      return truncate(str(a.name) ?? "", 80);
    case "ghIssue":
    case "ghPr": {
      const numStr = typeof a.number === "number" && Number.isFinite(a.number) ? `#${a.number}` : null;
      return truncate(
        [str(a.action), str(a.repo), numStr, str(a.title)].filter(Boolean).join(" "),
        80,
      );
    }
    case "httpRequest":
      return truncate(
        [str(a.method) ?? "GET", str(a.url)].filter(Boolean).join(" "),
        80,
      );
    case "curl":
      // Always GET; show the URL only. Headers may carry auth tokens, body is
      // not applicable for curl. queryParams collapse into the URL preview.
      return truncate(str(a.url) ?? "", 80);
    case "slackPostMessage":
      // body is intentionally NOT included (audit logger redacts it too).
      return truncate(str(a.channel) ?? "", 80);

    default: {
      // Generic fallback: list a couple of key=value pairs, redacting fields
      // that look sensitive (auth tokens, passwords, emails, …). Scalars are
      // shown verbatim; objects/arrays collapse to their JSON shape.
      const parts: string[] = [];
      for (const k of Object.keys(a).slice(0, 3)) {
        const v = a[k];
        if (v == null || v === "") continue;
        const display = isLikelyPiiKey(k) ? `<${typeof v}>` : compactScalar(v);
        parts.push(`${k}=${display}`);
      }
      return truncate(parts.join(" "), 80);
    }
  }
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1).trimEnd() + "…";
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

// ── Spotlight previews ─────────────────────────────────────────────────────
//
// Long-form, multi-line previews used by the spotlight card on the activity
// panel. Same PII-safety rules as `summarizeArgs`: strict whitelist per
// known tool, fallback to keys-only for the rest. Capped at MAX_SPOTLIGHT_CHARS.

export const MAX_SPOTLIGHT_CHARS = 600;

/**
 * Pretty-print tool args, key-per-row. Whitelisted fields only for known
 * tools; for unknown tools each key is rendered as `<jsType>` so the value
 * is never reflected back to the client.
 */
export function formatArgsForSpotlight(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;

  /** List the whitelisted keys vertically. Skips empty/undefined values. */
  const fmt = (keys: string[]): string =>
    keys
      .map((k) => {
        const v = a[k];
        if (v == null || v === "") return null;
        const value = typeof v === "string" ? v : JSON.stringify(v);
        return `${k}: ${truncate(value, 240)}`;
      })
      .filter((line): line is string => line !== null)
      .join("\n");

  let formatted: string;
  switch (toolName) {
    case "hubspotContact": {
      // Mirror the actual tool schema (hubspot-contact.tool.ts): include the
      // search-only fields `name`/`filters`/`customProperties`/`returnProperties`
      // so search-by-name and search-by-custom-property calls don't render as
      // a single bare "action: search" row.
      formatted = fmt([
        "action",
        "contactId",
        "firstName",
        "lastName",
        "email",
        "phone",
        "companyId",
        "name",
        "customProperties",
        "filters",
        "returnProperties",
      ]);
      // Diagnostic fallback: if the whitelist matched only `action` (or
      // nothing), dump every non-null arg so we never end up with a bare
      // "action: search" row that hides why the call was made. Covers cases
      // where the model passes an arg the whitelist forgot, or — more
      // likely — calls the tool with every criterion null (pathological).
      const lineCount = formatted ? formatted.split("\n").length : 0;
      if (lineCount <= 1) {
        const dumped: string[] = [];
        for (const k of Object.keys(a)) {
          if (k === "action") continue;
          const v = a[k];
          if (v == null || v === "") continue;
          const value = typeof v === "string" ? v : JSON.stringify(v);
          dumped.push(`${k}: ${truncate(value, 240)}`);
        }
        if (dumped.length === 0) {
          formatted = [formatted, "(nessun altro parametro)"].filter(Boolean).join("\n");
        } else {
          formatted = [formatted, ...dumped].filter(Boolean).join("\n");
        }
      }
      break;
    }
    case "hubspotDeal":
      formatted = fmt(["action", "dealName", "amount", "stage", "closeDate", "contactId"]);
      break;
    case "hubspotTicket":
      formatted = fmt(["action", "subject", "priority", "contactId"]);
      break;
    case "hubspotNote":
      // `body` is the actual note content the agent writes to the CRM — not
      // user PII, just what's being saved. Show it (auto-truncated to 240
      // chars by fmt()). Also expose noteId for update and query for search.
      formatted = fmt(["action", "contactId", "dealId", "ticketId", "noteId", "query", "body"]);
      break;
    case "hubspotSendEmail":
      formatted = fmt(["contactId", "subject"]); // body never reflected
      break;
    case "hubspotCreateTask":
      formatted = fmt(["subject", "priority", "dueDate", "contactId"]);
      break;
    case "hubspotMeeting":
      formatted = fmt(["action", "title", "startTime", "endTime", "contactId"]);
      break;
    case "hubspotGetCompany":
      formatted = fmt(["name", "domain"]);
      break;
    case "searchKnowledge":
    case "searchMemory":
    case "webSearch":
      formatted = fmt(["query", "limit"]);
      break;
    case "scheduleTask":
      formatted = fmt(["subject", "action", "dueDate"]);
      break;
    case "httpRequest":
      formatted = fmt(["method", "url"]); // body/headers stripped — may carry PII
      break;
    case "curl":
      // GET-only HTTP. Show url + queryParams. Headers stripped (auth tokens).
      formatted = fmt(["url", "queryParams"]);
      break;
    case "verifyDocument":
      formatted = fmt(["attachmentIndex", "kind"]);
      break;
    case "slackPostMessage":
      formatted = fmt(["channel"]); // message body stripped
      break;
    case "gitCloneRepo":
      formatted = fmt(["repo", "url"]);
      break;
    case "listDirectory":
    case "readFile":
    case "writeFile":
      formatted = fmt(["path"]);
      break;
    case "readSkill":
      formatted = fmt(["name"]);
      break;
    case "ghIssue":
    case "ghPr":
      formatted = fmt(["action", "repo", "number", "title"]);
      break;
    default: {
      // Unknown tool: emit values verbatim (truncated) for keys that don't
      // look like PII. Suspect keys (token, password, email, …) collapse
      // to `<typeof>`. Better than a wall of `<string>` for the audience.
      const lines: string[] = [];
      for (const k of Object.keys(a).slice(0, 8)) {
        const v = a[k];
        if (v === undefined) continue;
        const display = isLikelyPiiKey(k) ? `<${typeof v}>` : displayValue(v);
        lines.push(`${k}: ${display}`);
      }
      formatted = lines.join("\n");
    }
  }

  return truncate(formatted, MAX_SPOTLIGHT_CHARS);
}

/**
 * Long-form tool result preview. Strict whitelist per known tool: only
 * fields known to be public/safe (HubSpot returns `{id, url}`, search tools
 * return counts + titles). Unknown tools: keys-only.
 */
export function formatResultForSpotlight(toolName: string, result: unknown): string {
  if (result == null) return "";
  if (typeof result !== "object") {
    return truncate(typeof result === "string" ? result : String(result), MAX_SPOTLIGHT_CHARS);
  }
  const r = result as Record<string, unknown>;

  // HubSpot tools usually return a {id, url} envelope (sometimes wrapped in
  // {success, data}). Drill in.
  const inner = (r.data && typeof r.data === "object" ? r.data : r) as Record<string, unknown>;

  switch (toolName) {
    case "hubspotContact":
    case "hubspotDeal":
    case "hubspotTicket":
    case "hubspotNote":
    case "hubspotSendEmail":
    case "hubspotCreateTask":
    case "hubspotMeeting":
    case "hubspotGetCompany": {
      const lines = [
        str(inner.id) ? `id: ${inner.id}` : null,
        str(inner.url) ? `url: ${inner.url}` : null,
      ].filter((l): l is string => l !== null);
      if (lines.length === 0 && Array.isArray(inner.results)) {
        lines.push(`${inner.results.length} risultati`);
      }
      return truncate(lines.join("\n"), MAX_SPOTLIGHT_CHARS);
    }
    case "searchKnowledge":
    case "searchMemory":
    case "webSearch": {
      const items = pickSearchItems(inner);
      const header = `${items.length} risultati`;
      const titles = items
        .slice(0, 5)
        .map((it) => `• ${truncate(str(it.title) ?? str(it.name) ?? str(it.id) ?? "—", 120)}`);
      return truncate([header, ...titles].join("\n"), MAX_SPOTLIGHT_CHARS);
    }
    case "httpRequest": {
      const lines = [
        str(inner.status) || typeof inner.status === "number" ? `status: ${inner.status}` : null,
        typeof inner.bodyLength === "number" ? `body: ${inner.bodyLength} bytes` : null,
        Array.isArray(inner.results) ? `${inner.results.length} righe` : null,
      ].filter((l): l is string => l !== null);
      return truncate(lines.join("\n") || "ok", MAX_SPOTLIGHT_CHARS);
    }
    case "verifyDocument": {
      const lines = [
        typeof inner.match === "boolean" ? `match: ${inner.match}` : null,
        typeof inner.confidence === "number" ? `confidence: ${inner.confidence}` : null,
      ].filter((l): l is string => l !== null);
      return truncate(lines.join("\n") || "ok", MAX_SPOTLIGHT_CHARS);
    }
    default: {
      // Unknown tool: keys only.
      const keys = Object.keys(r).slice(0, 4);
      return truncate(keys.length ? keys.join(", ") : "ok", MAX_SPOTLIGHT_CHARS);
    }
  }
}

function pickSearchItems(inner: Record<string, unknown>): Array<Record<string, unknown>> {
  for (const k of ["results", "items", "documents", "memories"]) {
    const v = inner[k];
    if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
  }
  return [];
}

/**
 * Return true if the property name suggests sensitive content. The check is
 * conservative: a few false positives are fine (better redact than leak).
 */
const PII_KEY_PATTERN = /pass|token|secret|api[_-]?key|auth|bearer|credenti|email|phone|sso|cookie|cipher|signature|otp|jwt/i;
export function isLikelyPiiKey(key: string): boolean {
  return PII_KEY_PATTERN.test(key);
}

/**
 * Render a single value for the args spotlight body (multi-line view).
 * Strings are quoted and truncated, numbers/booleans verbatim, objects/
 * arrays collapse to JSON. Output is bounded — final cap is applied by
 * the caller via `truncate(MAX_SPOTLIGHT_CHARS)`.
 */
export function displayValue(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(truncate(v, 200));
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return truncate(JSON.stringify(v), 200);
  } catch {
    return `<${typeof v}>`;
  }
}

/** Compact one-line representation used by the inline summary fallback. */
export function compactScalar(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(truncate(v, 40));
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.length}]`;
  if (typeof v === "object") return "{…}";
  return `<${typeof v}>`;
}
