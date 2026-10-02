// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { CHANNEL_STATE_KEY, MAX_STATE_BYTES, PRIVATE_STATE_KEY } from "./state.buffer.js";
import { extractMappedFields, MAX_FIELD_MAPPING_ENTRIES, normalizeFieldMapping } from "./field-mapping.js";

describe("extractMappedFields", () => {
  it("should_map_top_level_field", () => {
    const out = extractMappedFields({ phone: "+39333" }, { phone: "phone" });
    expect(out).toEqual({ phone: "+39333" });
  });

  it("should_map_nested_field_via_dot_path", () => {
    const out = extractMappedFields(
      { customer: { phoneNumber: "+39333", id: "42" } },
      { phone: "customer.phoneNumber", contactId: "customer.id" },
    );
    expect(out).toEqual({ phone: "+39333", contactId: "42" });
  });

  it("should_omit_key_when_path_missing", () => {
    const out = extractMappedFields({ customer: {} }, { phone: "customer.phoneNumber" });
    expect(out).toEqual({});
  });

  it("should_include_null_when_path_resolves_to_null", () => {
    const out = extractMappedFields({ contactId: null }, { contactId: "contactId" });
    expect(out).toEqual({ contactId: null });
  });

  it("should_return_empty_object_when_mapping_empty", () => {
    expect(extractMappedFields({ a: 1 }, {})).toEqual({});
  });

  it("should_preserve_nested_object_and_array_values", () => {
    const out = extractMappedFields(
      { data: { tags: ["a", "b"], meta: { k: 1 } } },
      { payload: "data" },
    );
    expect(out).toEqual({ payload: { tags: ["a", "b"], meta: { k: 1 } } });
  });

  it("should_return_empty_when_payload_is_not_an_object", () => {
    expect(extractMappedFields("not-an-object", { phone: "phone" })).toEqual({});
    expect(extractMappedFields(null, { phone: "phone" })).toEqual({});
  });

  it("should_omit_when_path_traverses_a_non_object", () => {
    const out = extractMappedFields({ customer: "string" }, { phone: "customer.phoneNumber" });
    expect(out).toEqual({});
  });

  it("should_throw_when_state_key_is_the_reserved_channel_key", () => {
    expect(() => extractMappedFields({ x: 1 }, { [CHANNEL_STATE_KEY]: "x" })).toThrow(/reserved/i);
  });

  it("should_throw_when_state_key_is_a_prototype_pollution_key", () => {
    // JSON.parse creates "__proto__" as a real own, enumerable property (a bare
    // `{ __proto__: ... }` literal would set the prototype instead).
    const mapping = JSON.parse('{"__proto__":"x"}') as Record<string, string>;
    expect(() => extractMappedFields({ x: 1 }, mapping)).toThrow(/reserved/i);
  });

  it("should_throw_when_state_key_is_in_the_underscore_namespace", () => {
    // `_private` and any key a channel adapter or plugin keeps under a leading
    // underscore are engine-owned; a caller payload must not overwrite them.
    for (const key of [PRIVATE_STATE_KEY, "_adapterOwned"]) {
      expect(() => extractMappedFields({ x: 1 }, { [key]: "x" })).toThrow(/reserved/i);
    }
  });

  it("should_throw_when_extracted_state_exceeds_max_bytes", () => {
    const big = "x".repeat(MAX_STATE_BYTES + 1024);
    expect(() => extractMappedFields({ big }, { big: "big" })).toThrow(/exceed/i);
  });

  it("should_not_read_inherited_prototype_properties", () => {
    // `toString` exists on the prototype, not as an own property → must be omitted.
    const out = extractMappedFields({}, { ts: "toString" });
    expect(out).toEqual({});
  });
});

describe("normalizeFieldMapping", () => {
  it("should_trim_keys_and_paths_and_drop_blank_rows", () => {
    expect(normalizeFieldMapping({ " phone ": " caller.phone ", "": "ignored", "  ": "x" }, "m"))
      .toEqual({ phone: "caller.phone" });
  });

  it("should_refuse_what_is_not_a_mapping", () => {
    for (const value of [null, [], "phone", 3]) {
      expect(() => normalizeFieldMapping(value, "m")).toThrow(/must be an object/);
    }
    expect(() => normalizeFieldMapping({ phone: 3 }, "m")).toThrow(/must be a string path/);
  });

  it("should_refuse_reserved_keys_empty_segments_and_duplicates_after_trimming", () => {
    expect(() => normalizeFieldMapping({ [CHANNEL_STATE_KEY]: "x" }, "m")).toThrow(/reserved/);
    expect(() => normalizeFieldMapping({ [PRIVATE_STATE_KEY]: "x" }, "m")).toThrow(/reserved/);
    expect(() => normalizeFieldMapping({ " _adapterOwned": "x" }, "m")).toThrow(/reserved/);
    expect(() => normalizeFieldMapping({ phone: "" }, "m")).toThrow(/dot-path/);
    expect(() => normalizeFieldMapping({ phone: "caller..phone" }, "m")).toThrow(/dot-path/);
    expect(() => normalizeFieldMapping({ phone: "a", " phone": "b" }, "m")).toThrow(/mapped twice/);
  });

  it("should_cap_the_number_of_fields", () => {
    const many = Object.fromEntries(Array.from({ length: MAX_FIELD_MAPPING_ENTRIES + 1 }, (_, i) => [`k${i}`, `p${i}`]));
    expect(() => normalizeFieldMapping(many, "m")).toThrow(/more than/);
  });
});
