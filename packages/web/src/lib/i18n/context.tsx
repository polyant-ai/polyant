// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import {
  createContext,
  use,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Locale, TranslationKey } from "./types";
import { LOCALE_COOKIE, isLocale } from "./types";
import { catalogFor, loadCatalog } from "./catalogs";

/** Legacy storage of the choice, before it moved to a cookie the server can read. */
const LEGACY_STORAGE_KEY = "locale";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function persistLocale(locale: Locale) {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
}

/**
 * Looks a key up and fills its `{placeholders}`. Reads the locale's catalogue
 * once it has loaded (`I18nProvider` waits for it); before that a key reads as
 * itself.
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
  const table = (catalogFor(locale) ?? {}) as Record<string, string>;
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
 * the first render already speaks the right language. Only that language's
 * catalogue is downloaded: the provider waits for it (the server's HTML stays on
 * screen meanwhile), and a change of language takes effect once the other
 * catalogue has arrived, so no screen ever shows bare keys.
 */
export function I18nProvider({
  initialLocale,
  children,
}: {
  initialLocale: Locale;
  children: ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  // Suspends only until the catalogue first arrives; afterwards it is read directly.
  if (!catalogFor(locale)) use(loadCatalog(locale));
  // The last language asked for: a slower catalogue must not undo a later choice.
  const requested = useRef(locale);

  const setLocale = useCallback((newLocale: Locale) => {
    requested.current = newLocale;
    const apply = () => {
      if (requested.current !== newLocale) return;
      setLocaleState(newLocale);
      persistLocale(newLocale);
    };
    if (catalogFor(newLocale)) apply();
    // A catalogue that fails to load leaves the current language; asking again retries.
    else loadCatalog(newLocale).then(apply, () => {});
  }, []);

  useEffect(() => {
    // One-time move of a choice stored before the cookie existed.
    try {
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy === null) return;
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      if (isLocale(legacy)) setLocale(legacy);
    } catch {
      // Storage unavailable: nothing to migrate.
    }
  }, [setLocale]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

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
