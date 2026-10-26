// SPDX-License-Identifier: AGPL-3.0-or-later

import { extname } from "node:path";

/** Extension (lower-case, no dot) → the MIME type stored on a text document row. */
const TEXT_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  text: "text/plain",
  html: "text/html",
  htm: "text/html",
};

/** The MIME type stored for a filename, or `text/plain` for anything unrecognised. */
export function mimeForFilename(filename: string): string {
  const ext = extname(filename).replace(/^\./, "").toLowerCase();
  return TEXT_MIME_BY_EXTENSION[ext] ?? "text/plain";
}
