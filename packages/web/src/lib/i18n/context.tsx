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
import { DEFAULT_LOCALE, LOCALES } from "./types";
import en from "./locales/en.json";
import it from "./locales/it.json";

const STORAGE_KEY = "locale";

/**
 * Picks the first supported locale among the browser's preferred languages
 * (matching on the primary subtag, so "it-IT" -> "it"); English when none matches.
 */
export function detectBrowserLocale(
  languages: readonly string[] | undefined,
): Locale {
  for (const lang of languages ?? []) {
    const primary = lang.toLowerCase().split("-")[0];
    const match = LOCALES.find((l) => l === primary);
    if (match) return match;
  }
  return "en";
}

const TRANSLATIONS: Record<Locale, Translations> = {
  en: en as Translations,
  it: it as Translations,
};

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

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "it") {
      setLocaleState(stored);
      return;
    }
    // No explicit choice yet: follow the browser. Done after mount so the
    // server-rendered markup and the first client render still match.
    const preferred = navigator.languages?.length
      ? navigator.languages
      : [navigator.language];
    setLocaleState(detectBrowserLocale(preferred));
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale);
    localStorage.setItem(STORAGE_KEY, newLocale);
  }, []);

  const t: TranslateFn = useCallback(
    (key, params) => {
      let value: string = TRANSLATIONS[locale][key] ?? key;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          value = value.replaceAll(`{${k}}`, String(v));
        }
      }
      return value;
    },
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
