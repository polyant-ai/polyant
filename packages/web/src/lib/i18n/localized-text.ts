// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback } from "react";
import { useI18n } from "./context";
import { FALLBACK_LOCALE } from "./types";

/**
 * Text a plugin or a marketplace writes for people: one string per BCP 47 tag
 * (`it-IT`, `en-US`), or a plain string that stands for every locale. Mirrors
 * `plugin-system/localized-text.ts` in the engine, which serves it as written.
 */
export type LocalizedText = string | Readonly<Record<string, string>>;

const languageOf = (tag: string) => tag.split("-")[0].toLowerCase();

/**
 * The entry for `locale`: the same tag, else the same language (`it` reads
 * `it-IT`), else English, else the first tag in alphabetical order. Every step
 * is deterministic, so two readers in one locale always see the same text even
 * when the map came back from a store that does not keep key order.
 */
export function localizeText(text: LocalizedText, locale: string): string {
  if (typeof text === "string") return text;
  const tags = Object.keys(text).sort();
  const wanted = locale.toLowerCase();
  const pick =
    tags.find((tag) => tag.toLowerCase() === wanted) ??
    tags.find((tag) => languageOf(tag) === languageOf(locale)) ??
    tags.find((tag) => languageOf(tag) === FALLBACK_LOCALE) ??
    tags[0];
  return pick === undefined ? "" : text[pick];
}

interface Localize {
  (text: LocalizedText): string;
  (text: LocalizedText | null | undefined): string | undefined;
}

/** `localizeText` bound to the reader's locale; absent text stays absent. */
export function useLocalize(): Localize {
  const { locale } = useI18n();
  const localize = useCallback(
    (text: LocalizedText | null | undefined) => (text == null ? undefined : localizeText(text, locale)),
    [locale],
  );
  return localize as Localize;
}
