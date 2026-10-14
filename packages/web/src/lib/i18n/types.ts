// SPDX-License-Identifier: AGPL-3.0-or-later

import type en from "./locales/en.json";

export type Locale = "it" | "en";
export const LOCALES: Locale[] = ["it", "en"];
/** Used when neither the user's choice nor Accept-Language names a supported locale. */
export const FALLBACK_LOCALE: Locale = "en";
/** Cookie holding the user's explicit language choice; the server reads it on every render. */
export const LOCALE_COOKIE = "locale";

export type Translations = typeof en;
export type TranslationKey = keyof Translations;

export function isLocale(value: unknown): value is Locale {
  return LOCALES.some((l) => l === value);
}
