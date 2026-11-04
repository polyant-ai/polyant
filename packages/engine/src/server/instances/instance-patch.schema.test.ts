// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { PatchInstanceSchema } from "./instance-patch.schema.js";
import { resolveSTTProvider } from "../../stt-gateway/factory.js";
import { UPDATABLE_INSTANCE_KEYS } from "../../instances/instance-fields.js";

/** The values a z.enum field accepts, read from the schema itself. */
function enumValues(field: "sttProvider"): string[] {
  const shape = PatchInstanceSchema.shape[field].unwrap();
  return [...shape.options];
}

describe("PatchInstanceSchema enums match what the runtime runs", () => {
  it("accepts as speech-to-text setting only a provider the gateway resolves, or the opt-out", () => {
    const accepted = enumValues("sttProvider");
    expect(accepted).toContain("disabled");
    for (const name of accepted.filter((v) => v !== "disabled")) {
      expect(() => resolveSTTProvider(name as never)).not.toThrow();
    }
  });

  it("refuses a misspelt speech-to-text provider", () => {
    expect(PatchInstanceSchema.safeParse({ sttProvider: "openia" }).success).toBe(false);
  });
});

describe("PatchInstanceSchema covers the writable fields", () => {
  // The schema drops a key it does not declare, so a writable field missing here
  // is silently ignored by every PATCH. The icon has its own route.
  it("declares every field the store writes from a PATCH", () => {
    const declared = new Set(Object.keys(PatchInstanceSchema.shape));
    expect(UPDATABLE_INSTANCE_KEYS.filter((key) => key !== "icon" && !declared.has(key))).toEqual([]);
  });
});
