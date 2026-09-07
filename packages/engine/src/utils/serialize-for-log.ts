// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Turn any value into a string that is safe to put on disk or in a database row.
 *
 * Two failure modes this exists to close, both previously live:
 *
 * 1. `JSON.stringify(err)` is the WRONG tool for an Error. `message` and `stack`
 *    are non-enumerable, so it drops exactly the diagnostic text and keeps the
 *    custom fields — and driver-level errors from pg, the AWS SDK and fetch
 *    routinely carry the connection string, the request config or the
 *    `authorization` header on the error object. `index.ts` states this policy
 *    for the process-level handlers; `installFileLogger`, which is what actually
 *    lands in a fourteen-day file, did the opposite.
 *
 * 2. An uncapped, unredacted dump of a tool result into `tool_audit_logs.output`
 *    made that table a cleartext copy of everything the tools touched.
 *
 * Distinct from `sanitizeForLog`, which blanks control characters so a value
 * cannot forge a log line (CWE-117). They compose: this decides WHAT the text
 * says, that one decides that it stays one line.
 */

const DEFAULT_MAX_LENGTH = 4000;

/**
 * Key names whose VALUE is never safe to write. Matched case-insensitively and
 * as a substring, so `apiKey`, `api_key`, `api-key`, `X-Api-Key` and
 * `accessToken` are all covered by two entries.
 *
 * Deliberately matches the KEY, never the value: a value-shaped heuristic
 * ("looks like a JWT") both misses unfamiliar formats and mangles innocent text.
 */
const SECRET_KEY_RE =
  /(authorization|api[-_]?key|access[-_]?key|secret|token|password|passwd|credential|connection[-_]?string|cookie|bearer|private[-_]?key)/i;

/** `tokenCount` is not a token. Whole-word-ish exemptions for keys that contain
 *  a sensitive substring but hold a number or a label, never a credential. */
const SAFE_KEY_RE = /^(tokenCount|tokensUsed|inputTokens|outputTokens|totalTokens|tokenUsage|keyboard|secretsCount)$/;

function describeError(err: Error): string {
  return err.stack ?? `${err.name}: ${err.message}`;
}

export function serializeForLog(
  value: unknown,
  opts?: { maxLength?: number },
): string {
  const maxLength = opts?.maxLength ?? DEFAULT_MAX_LENGTH;
  let text: string;

  if (typeof value === "string") {
    text = value;
  } else if (value instanceof Error) {
    text = describeError(value);
  } else {
    const seen = new WeakSet<object>();
    try {
      text = JSON.stringify(value, function replacer(key, val) {
        if (key && SECRET_KEY_RE.test(key) && !SAFE_KEY_RE.test(key)) return "[redacted]";
        if (val instanceof Error) return describeError(val);
        if (val && typeof val === "object") {
          if (seen.has(val as object)) return "[circular]";
          seen.add(val as object);
        }
        return val;
      }) ?? String(value);
    } catch {
      // A getter that throws, a BigInt, an exotic proxy — a log line is never
      // worth taking a request down for.
      text = "[unserializable]";
    }
  }

  if (text.length > maxLength) {
    const dropped = text.length - maxLength;
    return `${text.slice(0, maxLength)}…[truncated ${dropped} chars]`;
  }
  return text;
}
