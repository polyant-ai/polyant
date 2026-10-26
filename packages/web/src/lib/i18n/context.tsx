// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { Locale, TranslationKey, Translations } from "./types";
import { LOCALE_COOKIE, isLocale } from "./types";
import en from "./locales/en.json";
import it from "./locales/it.json";

/** Legacy storage of the choice, before it moved to a cookie the server can read. */
const LEGACY_STORAGE_KEY = "locale";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function persistLocale(locale: Locale) {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
}

const TRANSLATIONS: Record<Locale, Translations> = {
  en: en as Translations,
  it: it as Translations,
};

/**
 * Looks a key up and fills its `{placeholders}`.
 *
 * Plurals: when `params.count` is a number (or its string form) and the file also holds `<key>_one`
 * (or `_zero`, `_two`, `_few`, `_many` for locales that need them), the form the
 * locale's plural rules pick for that count is used. The plain key stays the
 * general form, so a string only needs a `_one` sibling where its singular reads
 * differently ("1 documento" against "{count} documenti").
 */
export function translate(
  locale: Locale,
  key: TranslationKey,
  params?: Record<string, string | number>,
): string {
  const table = TRANSLATIONS[locale] as Record<string, string>;
  let value: string | undefined;
  // `count` arrives as a number or, from older call sites, as its string form.
  const count = params?.count === undefined || params.count === "" ? Number.NaN : Number(params.count);
  if (Number.isFinite(count)) {
    const category = new Intl.PluralRules(locale).select(count);
    if (category !== "other") value = table[`${key}_${category}`];
  }
  value ??= table[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      value = value.replaceAll(`{${k}}`, String(v));
    }
  }
  return value;
}

type TranslateFn = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: TranslateFn;
}

const I18nContext = createContext<I18nContextValue | null>(null);

/**
 * `initialLocale` is resolved on the server (cookie, then Accept-Language), so
 * the first render already speaks the right language.
 */
export function I18nProvider({
  initialLocale,
  children,
}: {
  initialLocale: Locale;
  children: ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  useEffect(() => {
    // One-time move of a choice stored before the cookie existed.
    try {
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy === null) return;
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      if (isLocale(legacy)) {
        persistLocale(legacy);
        setLocaleState(legacy);
      }
    } catch {
      // Storage unavailable: nothing to migrate.
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale);
    persistLocale(newLocale);
  }, []);

  const t: TranslateFn = useCallback(
    (key, params) => translate(locale, key, params),
    [locale],
  );

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}
