// SPDX-License-Identifier: AGPL-3.0-or-later

import { createRoot } from "react-dom/client";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import it_ from "./locales/it.json";
import en from "./locales/en.json";
import type { Locale, Translations } from "./types";

// The download of a language's strings is the slow boundary: here the Italian
// catalogue is already in the page and the English one arrives when the test says.
const pending = vi.hoisted(() => ({
  loaded: {} as Record<string, unknown>,
  en: null as Promise<unknown> | null,
  arriveEn: () => {},
  /** How many of the next English downloads fail, as a chunk a deploy removed or a dropped connection. */
  failingEn: 0,
}));
const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError } }));

vi.mock("./catalogs", () => ({
  catalogFor: (locale: Locale) => pending.loaded[locale] as Translations | undefined,
  loadCatalog: (locale: Locale) => {
    if (locale === "it") return Object.assign(Promise.resolve(it_), { status: "fulfilled", value: it_ });
    if (pending.failingEn > 0) {
      pending.failingEn--;
      return Promise.reject(new Error("Loading chunk failed"));
    }
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

/** Renders at the root of a page, outside act and with no boundary, as in the browser. */
async function renderAtRoot(initialLocale: Locale, run: (container: HTMLElement, errors: unknown[]) => Promise<void>) {
  const actEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  const errors: unknown[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container, {
    onRecoverableError: (error) => errors.push(error),
    onUncaughtError: (error) => errors.push(error),
    onCaughtError: (error) => errors.push(error),
  });
  try {
    root.render(
      <I18nProvider initialLocale={initialLocale}>
        <Probe />
      </I18nProvider>,
    );
    await run(container, errors);
  } finally {
    root.unmount();
    container.remove();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = actEnvironment;
  }
}

describe("I18nProvider first render", () => {
  beforeEach(() => {
    pending.loaded = { it: it_ };
    pending.en = null;
    pending.failingEn = 0;
  });

  it("tries the download of its language again when it fails, instead of failing the page", async () => {
    pending.failingEn = 1;
    await renderAtRoot("en", async (container, errors) => {
      // The first download failed; the second one is under way.
      await waitFor(() => expect(pending.en).not.toBeNull(), { timeout: 3_000 });
      pending.arriveEn();
      await waitFor(() => expect(within(container).getByRole("button")).toHaveTextContent("Agents"));
      expect(errors).toEqual([]);
    });
  });

  // Outside act, as in the browser: React keeps the half-rendered provider and
  // replays it once the catalogue arrives, instead of starting it over.
  it("waits for the catalogue of its language, then renders in it", async () => {
    const actEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    const errors: unknown[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container, {
      onRecoverableError: (error) => errors.push(error),
      onUncaughtError: (error) => errors.push(error),
      onCaughtError: (error) => errors.push(error),
    });
    try {
      // No boundary above it, as at the root of the page.
      root.render(
        <I18nProvider initialLocale="en">
          <Probe />
        </I18nProvider>,
      );
      setTimeout(() => pending.arriveEn(), 5);
      await waitFor(() => expect(within(container).getByRole("button")).toHaveTextContent("Agents"));
      expect(errors).toEqual([]);
    } finally {
      root.unmount();
      container.remove();
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = actEnvironment;
    }
  });

  // A catalogue that never arrives (the chunk is gone after a deploy) must not
  // leave the server's HTML on screen, inert and silent, forever. Last in this
  // block: the failed load stays for the page, as it does in the browser.
  it("gives up after a bounded number of tries and fails the page", async () => {
    pending.failingEn = Number.POSITIVE_INFINITY;
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      await renderAtRoot("en", async (_container, errors) => {
        await vi.advanceTimersByTimeAsync(60_000);
        vi.useRealTimers();
        await waitFor(() => expect(errors).not.toEqual([]));
        expect(String(errors[0])).toContain("Loading chunk failed");
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("I18nProvider language change", () => {
  beforeEach(() => {
    pending.loaded = { it: it_ };
    pending.en = null;
    pending.failingEn = 0;
    toastError.mockClear();
    document.cookie = "locale=; path=/; max-age=0";
  });

  it("says so, in the current language, when the other language cannot be downloaded", async () => {
    pending.failingEn = 1;
    render(
      <I18nProvider initialLocale="it">
        <Probe />
      </I18nProvider>,
    );
    const button = screen.getByRole("button");

    await act(async () => button.click());

    expect(button).toHaveTextContent("Agenti");
    expect(document.cookie).not.toContain("locale=en");
    expect(toastError).toHaveBeenCalledWith(it_["common.languageLoadFailed"]);
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
