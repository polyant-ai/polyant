// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomBytes } from "crypto";

/**
 * Putting somebody else's text into a prompt.
 *
 * A model cannot tell, inside the text it receives, what the operator wrote from
 * what a stranger wrote. The only thing that separates them is a boundary the
 * stranger cannot forge — which means a per-use random nonce in the tag, and the
 * closing tag scrubbed from the content as defence in depth.
 *
 * This discipline existed, correctly implemented, as two private functions in
 * `room/room-engine.ts` (see #84) — and nowhere else, so every later place that
 * interpolated untrusted text into a prompt did it plainly. Exported here so the
 * next author finds it instead of reinventing the plain version.
 *
 * Two shapes, because the threat differs:
 *
 * - `fenceUntrusted` for FREE TEXT of unknown shape (a webhook body, a fetched
 *   document): nonce-tagged, closing tag scrubbed.
 * - `singleLineValue` for a VALUE in a line-oriented block (`user_name: …`),
 *   where the whole attack is adding a line. No nonce needed — a value that
 *   cannot contain a newline or an angle bracket cannot open or close anything.
 */

export function makeDelimiter(tag: string, nonce: string): { open: string; close: string } {
  return { open: `<${tag}_${nonce}>`, close: `</${tag}_${nonce}>` };
}

export function scrubClosing(input: string, close: string): string {
  return input.split(close).join("[CLOSING-TAG-REMOVED]");
}

/** Wrap untrusted free text in a nonce-tagged block it cannot break out of. */
export function fenceUntrusted(tag: string, content: string, nonce?: string): string {
  const { open, close } = makeDelimiter(tag, nonce ?? randomBytes(8).toString("hex"));
  return `${open}\n${scrubClosing(content, close)}\n${close}`;
}

/**
 * Flatten an untrusted value for a `key: value` line.
 *
 * Newlines and carriage returns become spaces (the whole injection is the extra
 * line), and angle brackets are replaced so the value cannot close the block it
 * sits in or open a fake one. Long values are cut — a display name is a display
 * name.
 */
export function singleLineValue(value: string, maxLength = 200): string {
  const flat = value
    .replace(/[\r\n]+/g, " ")
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength)}…` : flat;
}
