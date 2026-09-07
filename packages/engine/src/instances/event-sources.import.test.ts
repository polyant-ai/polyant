// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { importEventSources } from "./event-sources.import.js";
import type { ExportInstanceData } from "./export.schema.js";

// importEventSources takes `tx` as a parameter (never imports `db` itself),
// so a minimal fake capturing insert() calls — plus a call-order log — is
// enough. Mirrors import.service.channels.test.ts / import.service.mcp.test.ts.
function makeFakeTx() {
  const insertedSources: Array<Record<string, unknown>> = [];
  const insertedDefinitions: Array<Record<string, unknown>> = [];
  const callOrder: string[] = [];
  let nextSourceId = 0;

  const tx = {
    insert: (_table: unknown) => {
      // Distinguish the two tables by the shape of `.values()` — the module
      // only ever inserts into eventSources (via .returning()) and
      // eventDefinitions (fire-and-forget), so branching on whether the
      // caller chains .returning() is unambiguous here.
      return {
        values: (v: Record<string, unknown>) => {
          if ("webhookToken" in v) {
            callOrder.push("insert:eventSource");
            insertedSources.push(v);
            const id = `source-${nextSourceId++}`;
            return { returning: (_cols: unknown) => Promise.resolve([{ id }]) };
          }
          callOrder.push("insert:eventDefinition");
          insertedDefinitions.push(v);
          return Promise.resolve();
        },
      };
    },
  };
  return { tx: tx as never, insertedSources, insertedDefinitions, callOrder };
}

function eventSource(
  overrides: Partial<ExportInstanceData["eventSources"][number]> = {},
): ExportInstanceData["eventSources"][number] {
  return {
    name: "Zendesk tickets",
    sourceType: "webhook",
    enabled: true,
    definitions: [],
    ...overrides,
  };
}

function eventDefinition(
  overrides: Partial<ExportInstanceData["eventSources"][number]["definitions"][number]> = {},
): ExportInstanceData["eventSources"][number]["definitions"][number] {
  return {
    name: "New urgent ticket",
    matchingPrompt: "ticket.priority == urgent",
    interpretationPrompt: "Summarize the ticket",
    enabled: true,
    action: "backlog",
    contextPrompt: null,
    outboundChannel: null,
    outboundTarget: null,
    ...overrides,
  };
}

describe("importEventSources", () => {
  it("returns no warnings and issues no writes for an empty list", async () => {
    const { tx, insertedSources, insertedDefinitions } = makeFakeTx();

    const warnings = await importEventSources(tx, "instance-1", []);

    expect(warnings).toEqual([]);
    expect(insertedSources).toEqual([]);
    expect(insertedDefinitions).toEqual([]);
  });

  it("inserts the source then its definitions, in that order, and warns event_source_credentials", async () => {
    const { tx, insertedSources, insertedDefinitions, callOrder } = makeFakeTx();

    const warnings = await importEventSources(tx, "instance-1", [
      eventSource({
        name: "Zendesk tickets",
        sourceType: "webhook",
        enabled: true,
        definitions: [eventDefinition({ name: "New urgent ticket" })],
      }),
    ]);

    expect(callOrder).toEqual(["insert:eventSource", "insert:eventDefinition"]);

    expect(insertedSources).toHaveLength(1);
    expect(insertedSources[0]).toMatchObject({
      instanceId: "instance-1",
      name: "Zendesk tickets",
      sourceType: "webhook",
      config: "",
      enabled: false, // always disabled on import, regardless of source.enabled
    });
    // A fresh server-minted token — never anything from the bundle.
    expect(insertedSources[0].webhookToken).toMatch(/^[0-9a-f]{64}$/);

    expect(insertedDefinitions).toHaveLength(1);
    expect(insertedDefinitions[0]).toMatchObject({
      eventSourceId: "source-0",
      name: "New urgent ticket",
      matchingPrompt: "ticket.priority == urgent",
      interpretationPrompt: "Summarize the ticket",
      action: "backlog",
      contextPrompt: null,
      outboundChannel: null,
      outboundTarget: null,
      enabled: true,
    });

    expect(warnings).toEqual([
      { type: "event_source_credentials", message: 'Event source "Zendesk tickets" imported without credentials — configure manually' },
    ]);
  });

  it("inserts every definition of a source, in array order, all pointing at the same created source id", async () => {
    const { tx, insertedDefinitions } = makeFakeTx();

    await importEventSources(tx, "instance-1", [
      eventSource({
        name: "Multi-def source",
        definitions: [
          eventDefinition({ name: "first" }),
          eventDefinition({ name: "second" }),
        ],
      }),
    ]);

    expect(insertedDefinitions.map((d) => d.name)).toEqual(["first", "second"]);
    expect(insertedDefinitions.every((d) => d.eventSourceId === "source-0")).toBe(true);
  });

  it("produces one warning per source and assigns each definition to its OWN source id", async () => {
    const { tx, insertedDefinitions, callOrder } = makeFakeTx();

    const warnings = await importEventSources(tx, "instance-1", [
      eventSource({ name: "source-a", definitions: [eventDefinition({ name: "def-a" })] }),
      eventSource({ name: "source-b", definitions: [eventDefinition({ name: "def-b" })] }),
    ]);

    expect(warnings.map((w) => w.message)).toEqual([
      'Event source "source-a" imported without credentials — configure manually',
      'Event source "source-b" imported without credentials — configure manually',
    ]);
    expect(callOrder).toEqual([
      "insert:eventSource",
      "insert:eventDefinition",
      "insert:eventSource",
      "insert:eventDefinition",
    ]);
    expect(insertedDefinitions[0]).toMatchObject({ name: "def-a", eventSourceId: "source-0" });
    expect(insertedDefinitions[1]).toMatchObject({ name: "def-b", eventSourceId: "source-1" });
  });
});
