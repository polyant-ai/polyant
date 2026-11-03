// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { PatchInstanceSchema } from "./instance-patch.schema.js";
import { resolveSTTProvider } from "../../stt-gateway/factory.js";

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
