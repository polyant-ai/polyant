// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { localizeText } from "./localized-text";

describe("localizeText", () => {
  const text = { "it-IT": "Ciao", "en-US": "Hello", "pt-BR": "Olá" };

  it("returns a plain string for every locale", () => {
    expect(localizeText("Hello", "it")).toBe("Hello");
  });

  it("prefers the same tag, then the same language", () => {
    expect(localizeText(text, "pt-BR")).toBe("Olá");
    expect(localizeText(text, "it")).toBe("Ciao");
    expect(localizeText({ "en-GB": "Colour", "en-US": "Color" }, "en")).toBe("Colour");
  });

  it("falls back to English, then to the first tag in alphabetical order", () => {
    expect(localizeText(text, "de")).toBe("Hello");
    expect(localizeText({ "it-IT": "Ciao", "fr-FR": "Salut" }, "de")).toBe("Salut");
  });
});
