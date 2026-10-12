// SPDX-License-Identifier: AGPL-3.0-or-later

import { FALLBACK_LOCALE, isLocale, LOCALES, type Locale } from "./types";

/** Supported locale for the first Accept-Language entry that has one, by primary subtag, highest q first. */
export function matchAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const ranked = header
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith("q="));
      const weight = q === undefined ? 1 : Number(q.slice(2));
      return { tag: tag.toLowerCase(), weight, index };
    })
    .filter((e) => e.tag && e.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const { tag } of ranked) {
    const match = LOCALES.find((l) => l === tag.split("-")[0]);
    if (match) return match;
  }
  return null;
}

/** Explicit choice (cookie), then the browser's Accept-Language, then English. */
export function resolveLocale(input: {
  cookie?: string | null;
  acceptLanguage?: string | null;
}): Locale {
  if (isLocale(input.cookie)) return input.cookie;
  return matchAcceptLanguage(input.acceptLanguage) ?? FALLBACK_LOCALE;
}
