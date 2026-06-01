// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { buildPhoneFilterGroups } from "./hubspot-fetch.js";

describe("buildPhoneFilterGroups", () => {
  it("emits phone + mobilephone EQ groups for both +/no-+ E.164 variants", () => {
    const groups = buildPhoneFilterGroups("+14155550100");
    const flat = groups.flatMap((g) => g.filters);
    expect(flat).toContainEqual({ propertyName: "phone", operator: "EQ", value: "+14155550100" });
    expect(flat).toContainEqual({ propertyName: "mobilephone", operator: "EQ", value: "+14155550100" });
    expect(flat).toContainEqual({ propertyName: "phone", operator: "EQ", value: "14155550100" });
    expect(flat).toContainEqual({ propertyName: "mobilephone", operator: "EQ", value: "14155550100" });
  });

  it("adds a CONTAINS_TOKEN fallback on the last 10 digits when the input has >= 10 digits", () => {
    // A stored value whose country code diverges from the query still matches
    // on the digits-only mirror via the last 10 digits.
    const groups = buildPhoneFilterGroups("+1 (415) 555-0100");
    const fallback = groups
      .flatMap((g) => g.filters)
      .find((f) => f.propertyName === "hs_searchable_calculated_phone_number");
    expect(fallback).toEqual({
      propertyName: "hs_searchable_calculated_phone_number",
      operator: "CONTAINS_TOKEN",
      value: "4155550100",
    });
  });

  it("does NOT emit the CONTAINS_TOKEN fallback for short inputs (< 10 digits)", () => {
    // CONTAINS_TOKEN on a handful of digits would match too many unrelated contacts.
    const groups = buildPhoneFilterGroups("12345");
    const hasFallback = groups
      .flatMap((g) => g.filters)
      .some((f) => f.propertyName === "hs_searchable_calculated_phone_number");
    expect(hasFallback).toBe(false);
  });
});
