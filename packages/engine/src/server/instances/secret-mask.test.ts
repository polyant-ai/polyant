// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { MASK, isMaskedPlaceholder, maskSecret } from "./secret-mask.js";

describe("maskSecret", () => {
  it("should_keep_the_last_four_characters_of_a_long_secret", () => {
    expect(maskSecret("abcdef123456")).toBe(`${MASK}3456`);
    expect(maskSecret("123456789")).toBe(`${MASK}6789`);
  });

  it("should_hide_a_secret_of_eight_characters_or_fewer_entirely", () => {
    expect(maskSecret("123456")).toBe(MASK);
    expect(maskSecret("12345678")).toBe(MASK);
  });
});

describe("isMaskedPlaceholder", () => {
  it("should_recognise_a_masked_value_and_nothing_else", () => {
    expect(isMaskedPlaceholder(`${MASK}3456`)).toBe(true);
    expect(isMaskedPlaceholder(MASK)).toBe(true);
    expect(isMaskedPlaceholder("plain")).toBe(false);
    expect(isMaskedPlaceholder(undefined)).toBe(false);
    expect(isMaskedPlaceholder(null)).toBe(false);
  });
});
