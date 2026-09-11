// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The one parser for an attachment key as it arrives from the HTTP layer, and
 * the one place its shape is written down: `attachments/{agentSlug}/{conversationId}/{fileName}`.
 *
 * It exists because the wildcard route param is NOT a string. Express 5 /
 * path-to-regexp 8 hand `*key` to the handler as an ARRAY of already-decoded
 * segments, and every consumer had typed it `string`:
 *
 *   ["attachments", "agent-a", "conv-1", "report.pdf"]
 *
 * `String()` on that joins with COMMAS, so a key-shape regex tested against it
 * can only ever fail — which is how the download endpoint came to refuse every
 * attachment ever stored, and why it refused them as a plain 404 that reads like
 * "no such file" instead of as a crash. Anything reaching for `.split("/")` got
 * a TypeError instead.
 *
 * So the shape is a framework detail that has already changed once. Both forms
 * are accepted here, and callers get a validated string back.
 *
 * VALIDATION IS ON THE SEGMENTS, never on the recomposed string. The segments
 * are decoded before they arrive, so a single one can itself contain a `/` (from
 * `%2F`) or a `..` — recomposing first and pattern-matching after would read
 * `attachments/a/c/x%2Fy.pdf` as a well-formed four-segment key. Counting the
 * segments the router actually produced is what makes that unrepresentable.
 */

/** Where an attachment lives, once the key has been proven well-formed. */
export interface AttachmentKey {
  /** The canonical `attachments/…` key, safe to hand to S3. */
  readonly key: string;
  /** The agent that owns the object — the tenant the caller must be checked against. */
  readonly agentSlug: string;
  /** The conversation the attachment belongs to. */
  readonly conversationId: string;
  /** The stored file name, for Content-Disposition. */
  readonly fileName: string;
}

const EXPECTED_SEGMENTS = 4;
const PREFIX = "attachments";

/**
 * Parse and validate. `null` for anything that is not exactly one well-formed
 * key — the caller turns that into its own refusal, since the attachments route
 * answers every denial with the same 404.
 */
export function parseAttachmentKey(raw: unknown): AttachmentKey | null {
  const segments = typeof raw === "string" ? raw.split("/") : raw;
  if (!Array.isArray(segments)) return null;
  if (segments.length !== EXPECTED_SEGMENTS) return null;

  for (const segment of segments) {
    if (typeof segment !== "string") return null;
    // Empty rejects `attachments//c/f`. The separator check rejects one that
    // arrived INSIDE a segment, percent-decoded by the router.
    if (segment.length === 0) return null;
    if (segment.includes("/") || segment.includes("\\")) return null;
    // Only a segment that IS a traversal. A `..` in the MIDDLE of a name cannot
    // traverse anything once the separators above are excluded and the count is
    // fixed, and rejecting it was how `report..pdf` came to be stored and then
    // refused on every read — the validation being in the wrong place rather
    // than the name being wrong.
    if (segment === "." || segment === "..") return null;
  }

  const [prefix, agentSlug, conversationId, fileName] = segments as string[];
  if (prefix !== PREFIX) return null;

  return { key: segments.join("/"), agentSlug, conversationId, fileName };
}
