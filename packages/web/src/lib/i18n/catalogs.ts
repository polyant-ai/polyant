// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Locale, Translations } from "./types";

/**
 * The string catalogues, one chunk per language, loaded the first time a
 * language is needed: a page downloads the language it speaks, not all of them.
 *
 * One promise is kept per language. Once it settles it is marked the way React's
 * `use()` reads a settled promise, so a catalogue already here renders without
 * suspending. A failed load is forgotten, so the next request tries again.
 */
const IMPORTS: Record<Locale, () => Promise<unknown>> = {
  en: () => import("./locales/en.json"),
  it: () => import("./locales/it.json"),
};

const promises: Partial<Record<Locale, Promise<Translations>>> = {};
const loaded: Partial<Record<Locale, Translations>> = {};

export function loadCatalog(locale: Locale): Promise<Translations> {
  const existing = promises[locale];
  if (existing) return existing;
  const promise: Promise<Translations> = IMPORTS[locale]().then(
    (module) => {
      const catalog = ((module as { default?: unknown }).default ?? module) as Translations;
      loaded[locale] = catalog;
      Object.assign(promise, { status: "fulfilled", value: catalog });
      return catalog;
    },
    (err: unknown) => {
      delete promises[locale];
      throw err;
    },
  );
  promises[locale] = promise;
  return promise;
}

/** The catalogue of a language, once it has loaded. */
export function catalogFor(locale: Locale): Translations | undefined {
  return loaded[locale];
}
