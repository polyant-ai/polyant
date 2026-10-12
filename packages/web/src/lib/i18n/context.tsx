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
