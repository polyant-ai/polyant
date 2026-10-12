// SPDX-License-Identifier: AGPL-3.0-or-later

import { matchAcceptLanguage, resolveLocale } from "./resolve";

describe("matchAcceptLanguage", () => {
  it("matches on the primary subtag", () => {
    expect(matchAcceptLanguage("it-IT,it;q=0.9")).toBe("it");
    expect(matchAcceptLanguage("en-GB")).toBe("en");
  });

  it("honours q-values over header order", () => {
    expect(matchAcceptLanguage("fr;q=0.9,en;q=0.5,it;q=0.8")).toBe("it");
  });

  it("skips unsupported and refused languages", () => {
    expect(matchAcceptLanguage("fr-FR,de;q=0.8")).toBeNull();
    expect(matchAcceptLanguage("it;q=0,en;q=0.1")).toBe("en");
  });

  it("returns null for a missing header", () => {
    expect(matchAcceptLanguage(null)).toBeNull();
    expect(matchAcceptLanguage("")).toBeNull();
  });
});

describe("resolveLocale", () => {
  it("lets the cookie win over Accept-Language", () => {
    expect(resolveLocale({ cookie: "it", acceptLanguage: "en-US" })).toBe("it");
  });

  it("ignores an invalid cookie value", () => {
    expect(resolveLocale({ cookie: "fr", acceptLanguage: "it" })).toBe("it");
  });

  it("falls back to Accept-Language, then English", () => {
    expect(resolveLocale({ acceptLanguage: "it-IT" })).toBe("it");
    expect(resolveLocale({ acceptLanguage: "fr-FR" })).toBe("en");
    expect(resolveLocale({})).toBe("en");
  });
});
