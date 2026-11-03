// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, render, screen } from "@testing-library/react";
import it_ from "./locales/it.json";
import en from "./locales/en.json";
import type { Locale, Translations } from "./types";

// The download of a language's strings is the slow boundary: here the Italian
// catalogue is already in the page and the English one arrives when the test says.
const pending = vi.hoisted(() => ({
  loaded: {} as Record<string, unknown>,
  en: null as Promise<unknown> | null,
  arriveEn: () => {},
}));

vi.mock("./catalogs", () => ({
  catalogFor: (locale: Locale) => pending.loaded[locale] as Translations | undefined,
  loadCatalog: (locale: Locale) => {
    if (locale === "it") return Object.assign(Promise.resolve(it_), { status: "fulfilled", value: it_ });
    pending.en ??= new Promise((resolve) => {
      pending.arriveEn = () => {
        pending.loaded.en = en;
        resolve(en);
      };
    });
    return pending.en;
  },
}));

import { I18nProvider, useI18n } from "./context";

function Probe() {
  const { t, setLocale } = useI18n();
  return <button onClick={() => setLocale("en")}>{t("nav.instances")}</button>;
}

describe("I18nProvider language change", () => {
  beforeEach(() => {
    pending.loaded = { it: it_ };
    pending.en = null;
    document.cookie = "locale=; path=/; max-age=0";
  });

  it("keeps the current language until the other catalogue has arrived", async () => {
    render(
      <I18nProvider initialLocale="it">
        <Probe />
      </I18nProvider>,
    );
    const button = screen.getByRole("button");
    expect(button).toHaveTextContent("Agenti");

    act(() => button.click());
    // Neither a bare key nor the new language yet, and the choice is not saved.
    expect(button).toHaveTextContent("Agenti");
    expect(document.cookie).not.toContain("locale=en");

    await act(async () => pending.arriveEn());
    expect(button).toHaveTextContent("Agents");
    expect(document.cookie).toContain("locale=en");
  });
});
