// SPDX-License-Identifier: AGPL-3.0-or-later

import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { I18nProvider, useI18n } from "./context";

// ── Wrapper ────────────────────────────────────────────────────────────

function wrapper({ children }: { children: ReactNode }) {
  return <I18nProvider>{children}</I18nProvider>;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("I18nProvider + useI18n", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.lang = "";
  });

  it("returns Italian translation by default (DEFAULT_LOCALE is 'it')", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });

    expect(result.current.locale).toBe("it");
    // "nav.playground" is "Playground" in both, pick one that differs
    // "nav.instances" = "Agenti" in it, "Agents" in en
    expect(result.current.t("nav.instances")).toBe("Agenti");
  });

  it("returns the key itself for unknown keys", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });

    const unknownKey = "some.unknown.key" as Parameters<typeof result.current.t>[0];
    expect(result.current.t(unknownKey)).toBe("some.unknown.key");
  });

  it("substitutes {param} placeholders via params argument", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });

    // "conversations.detail.messages" = "{count} messaggi" in Italian
    const translated = result.current.t("conversations.detail.messages", {
      count: 42,
    });
    expect(translated).toBe("42 messaggi");
  });

  it("switches to English translations when setLocale('en') is called", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });

    act(() => {
      result.current.setLocale("en");
    });

    expect(result.current.locale).toBe("en");
    expect(result.current.t("nav.instances")).toBe("Agents");
  });

  it("persists locale to localStorage when setLocale() is called", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });

    act(() => {
      result.current.setLocale("en");
    });

    expect(localStorage.getItem("locale")).toBe("en");
  });

  it("reads initial locale from localStorage", () => {
    localStorage.setItem("locale", "en");

    const { result } = renderHook(() => useI18n(), { wrapper });

    // useEffect runs after render, so we need to wait for the effect
    // renderHook with RTL will flush effects automatically
    expect(result.current.locale).toBe("en");
    expect(result.current.t("nav.instances")).toBe("Agents");
  });

  it("sets document.documentElement.lang to the current locale", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });

    expect(document.documentElement.lang).toBe("it");

    act(() => {
      result.current.setLocale("en");
    });

    expect(document.documentElement.lang).toBe("en");
  });

  it("ignores invalid locale values in localStorage", () => {
    localStorage.setItem("locale", "fr");

    const { result } = renderHook(() => useI18n(), { wrapper });

    // "fr" is not valid, so the browser language (pinned to Italian) applies
    expect(result.current.locale).toBe("it");
  });

  describe("browser language detection", () => {
    function setBrowser(languages: string[]) {
      Object.defineProperty(navigator, "languages", {
        value: languages,
        configurable: true,
      });
    }
    afterEach(() => setBrowser(["it-IT", "it"]));

    it("starts in English for an English browser with nothing stored", () => {
      setBrowser(["en-GB", "en"]);
      const { result } = renderHook(() => useI18n(), { wrapper });
      expect(result.current.locale).toBe("en");
    });

    it("picks the first supported language in the browser preference list", () => {
      setBrowser(["fr-FR", "it-IT", "en"]);
      const { result } = renderHook(() => useI18n(), { wrapper });
      expect(result.current.locale).toBe("it");
    });

    it("falls back to English when no browser language is supported", () => {
      setBrowser(["fr-FR", "de"]);
      const { result } = renderHook(() => useI18n(), { wrapper });
      expect(result.current.locale).toBe("en");
    });

    it("lets a stored choice win over the browser language", () => {
      setBrowser(["en-US"]);
      localStorage.setItem("locale", "it");
      const { result } = renderHook(() => useI18n(), { wrapper });
      expect(result.current.locale).toBe("it");
    });
  });

  it("handles multiple placeholder substitutions", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });

    // Switch to English to use a known key with placeholder
    act(() => {
      result.current.setLocale("en");
    });

    // "instances.detail.deleteDescription" has {name} placeholder
    const translated = result.current.t(
      "instances.detail.deleteDescription",
      { name: "My Bot" },
    );
    expect(translated).toContain("My Bot");
    expect(translated).not.toContain("{name}");
  });
});

describe("useI18n outside provider", () => {
  it("throws an Error when used outside I18nProvider", () => {
    // Suppress console.error noise from React during expected error
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => {
      renderHook(() => useI18n());
    }).toThrow("useI18n must be used within I18nProvider");

    spy.mockRestore();
  });
});
