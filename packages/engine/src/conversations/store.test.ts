// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The conversation store's pure helpers. Everything that reads or writes rows is
 * tested against Postgres in `store.integration.test.ts` and the other
 * `*.integration.test.ts` files of this folder.
 */

import { describe, expect, it } from "vitest";
import { escapeLikePattern, normalizeTitle, MAX_TITLE_CHARS } from "./store.js";

describe("escapeLikePattern", () => {
  it("escapes LIKE wildcards and the escape char", () => {
    expect(escapeLikePattern("50%_x")).toBe("50\\%\\_x");
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
  });

  it("leaves plain input untouched", () => {
    expect(escapeLikePattern("web:conv-123")).toBe("web:conv-123");
  });
});

describe("normalizeTitle", () => {
  it("drops a leading speaker label the model echoed from the transcript", () => {
    expect(normalizeTitle("User: Prenotare una visita")).toBe("Prenotare una visita");
    expect(normalizeTitle("Utente: Prenotare una visita")).toBe("Prenotare una visita");
    expect(normalizeTitle("Assistant: Orari di apertura")).toBe("Orari di apertura");
  });

  it("drops wrapping quotes, also around a speaker label", () => {
    expect(normalizeTitle('"📊 Sales dashboard"')).toBe("📊 Sales dashboard");
    expect(normalizeTitle('"User: Fattura errata"')).toBe("Fattura errata");
  });

  it("keeps a short single-line title untouched", () => {
    expect(normalizeTitle("🐍 Tutorial gioco snake in Python")).toBe("🐍 Tutorial gioco snake in Python");
  });

  it("keeps only the first non-empty line", () => {
    expect(normalizeTitle("\n\nHere is the title:\nSecond line")).toBe("Here is the title:");
  });

  it("collapses whitespace and trims", () => {
    expect(normalizeTitle("  Titolo   con    spazi  ")).toBe("Titolo con spazi");
  });

  it("caps an overlong title with an ellipsis", () => {
    const result = normalizeTitle("a".repeat(500));
    expect(result).toHaveLength(MAX_TITLE_CHARS);
    expect(result.endsWith("…")).toBe(true);
  });

  it("returns an empty string for whitespace-only input", () => {
    expect(normalizeTitle("   \n  ")).toBe("");
  });
});
