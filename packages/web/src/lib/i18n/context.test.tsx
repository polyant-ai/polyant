// SPDX-License-Identifier: AGPL-3.0-or-later

import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { I18nProvider, useI18n } from "./context";
import type { Locale } from "./types";

// ── Wrapper ────────────────────────────────────────────────────────────

function wrapperFor(initialLocale: Locale) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <I18nProvider initialLocale={initialLocale}>{children}</I18nProvider>;
  };
}
const wrapper = wrapperFor("it");

function readCookie() {
  return document.cookie
    .split("; ")
    .find((c) => c.startsWith("locale="))
    ?.slice("locale=".length);
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("I18nProvider + useI18n", () => {
  beforeEach(() => {
    localStorage.clear();
    document.cookie = "locale=; path=/; max-age=0";
    document.documentElement.lang = "";
  });

  it("renders the server-given locale on the first render", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });

    expect(result.current.locale).toBe("it");
    // "nav.playground" is "Playground" in both, pick one that differs
    // "nav.instances" = "Agenti" in it, "Agents" in en
    expect(result.current.t("nav.instances")).toBe("Agenti");
  });

  it("renders English on the first render when the server says so", () => {
    const { result } = renderHook(() => useI18n(), { wrapper: wrapperFor("en") });
    expect(result.current.t("nav.instances")).toBe("Agents");
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

  it("persists the choice to a cookie when setLocale() is called", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });

    act(() => {
      result.current.setLocale("en");
    });

    expect(readCookie()).toBe("en");
  });

  it("migrates a legacy localStorage choice to the cookie once", () => {
    localStorage.setItem("locale", "en");

    const { result } = renderHook(() => useI18n(), { wrapper });

    expect(result.current.locale).toBe("en");
    expect(readCookie()).toBe("en");
    expect(localStorage.getItem("locale")).toBeNull();
  });

  it("sets document.documentElement.lang to the current locale", () => {
    const { result } = renderHook(() => useI18n(), { wrapper });

    expect(document.documentElement.lang).toBe("it");

    act(() => {
      result.current.setLocale("en");
    });

    expect(document.documentElement.lang).toBe("en");
  });

  it("ignores an invalid legacy localStorage value", () => {
    localStorage.setItem("locale", "fr");

    const { result } = renderHook(() => useI18n(), { wrapper });

    expect(result.current.locale).toBe("it");
    expect(readCookie()).toBeUndefined();
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
