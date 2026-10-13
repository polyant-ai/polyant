// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";

/**
 * A BCP 47 tag as plugin text is keyed: language, optional script, optional
 * region (`it-IT`, `en-US`, `zh-Hant-TW`). Casing is canonical so two spellings
 * of one locale cannot both appear in a map.
 */
export const LOCALE_TAG_PATTERN = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?$/;

/**
 * Text a person reads about a plugin: one string per locale, or a plain string
 * that stands for every locale. The engine stores and serves it as written; the
 * panel picks the entry for its reader, so a new language needs no engine change.
 */
export type LocalizedText = string | Readonly<Record<string, string>>;

export function localizedTextSchema(options: { max?: number } = {}): z.ZodType<LocalizedText> {
  const text = options.max === undefined ? z.string().min(1) : z.string().min(1).max(options.max);
  return z.union([
    text,
    z
      .record(z.string().regex(LOCALE_TAG_PATTERN, "must be a BCP 47 tag such as it-IT or en-US"), text)
      .refine((entries) => Object.keys(entries).length > 0, "must name at least one locale"),
  ]);
}
