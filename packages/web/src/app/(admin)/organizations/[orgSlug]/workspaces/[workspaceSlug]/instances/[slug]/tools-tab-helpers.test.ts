// SPDX-License-Identifier: AGPL-3.0-or-later

import { capabilitySummary, categoryLabel, hookSummary } from "./tools-tab-helpers";
import { secretSpecDescription, secretSpecLabel } from "@/components/instance-secret/secret-spec-field";

describe("text people read about a tool", () => {
  it("prefers the summary in the reader's language, else the first line of the description", () => {
    const tool = { description: "Look up an order.\nCall it before refunding.", summary: { "en-US": "Looks up an order.", "it-IT": "Cerca un ordine." } };
    expect(capabilitySummary(tool, "it")).toBe("Cerca un ordine.");
    expect(capabilitySummary(tool, "en")).toBe("Looks up an order.");
    expect(capabilitySummary({ description: "\nLook up an order.\nRules." }, "it")).toBe("Look up an order.");
  });

  it("shows a hook's summary, else its whole description", () => {
    expect(hookSummary({ description: "Greets.", summary: { "it-IT": "Saluta." } }, "it")).toBe("Saluta.");
    expect(hookSummary({ description: "Greets the caller." }, "it")).toBe("Greets the caller.");
  });

  it("names a known category in the reader's language and capitalizes an unknown id", () => {
    expect(categoryLabel("files", "it")).toBe("File");
    expect(categoryLabel("support", "en")).toBe("Customer support");
    expect(categoryLabel("dentalpro", "it")).toBe("Dentalpro");
    expect(categoryLabel("constructor", "en")).toBe("Constructor");
  });

  it("names a parameter by its label in the reader's language, else by its key", () => {
    const spec = { key: "crm_api_key", label: { "en-US": "CRM API key", "it-IT": "Chiave API del CRM" }, description: { "en-US": "From Settings.", "it-IT": "Da Impostazioni." } };
    expect(secretSpecLabel(spec, "it")).toBe("Chiave API del CRM");
    expect(secretSpecDescription(spec, "en")).toBe("From Settings.");
    expect(secretSpecLabel({ key: "crm_api_key" }, "it")).toBe("Crm API Key");
    expect(secretSpecDescription({}, "it")).toBeUndefined();
  });
});
