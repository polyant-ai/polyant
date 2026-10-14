// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { LOCALE_TAG_PATTERN as SDK_LOCALE_TAG_PATTERN, type LocalizedText as SdkLocalizedText } from "@polyant-ai/plugin-sdk";
import { LOCALE_TAG_PATTERN, localizedTextSchema, type LocalizedText } from "./localized-text.js";

describe("localized text — one contract with the SDK", () => {
  // The engine keeps its own copy so the marketplace can vendor this file
  // without the SDK; a plugin that passes the SDK's load-time check must
  // pass the engine's validation, so the two patterns stay byte-identical.
  it("uses the SDK's tag pattern", () => {
    expect(LOCALE_TAG_PATTERN.source).toBe(SDK_LOCALE_TAG_PATTERN.source);
    expect(LOCALE_TAG_PATTERN.flags).toBe(SDK_LOCALE_TAG_PATTERN.flags);
  });

  it("has the SDK's type", () => {
    const fromSdk: SdkLocalizedText = { "en-US": "Hi" };
    const here: LocalizedText = fromSdk;
    const back: SdkLocalizedText = here;
    expect(back).toBe(fromSdk);
  });

  it("accepts a string or a map of canonical tags and rejects the rest", () => {
    const schema = localizedTextSchema({ max: 10 });
    expect(schema.safeParse("Hi").success).toBe(true);
    expect(schema.safeParse({ "en-US": "Hi", it: "Ciao" }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ en_US: "Hi" }).success).toBe(false);
    expect(schema.safeParse({ "en-US": "x".repeat(11) }).success).toBe(false);
  });
});
