// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { auditStore, type AuditEntry } from "./audit.store.js";
import { type InstanceSlug } from "../instances/identifiers.js";

/**
 * One malformed entry must not cost an instance its audit trail.
 *
 * The bug this suite pins down was observed in production logs: a plugin called
 * `ctx.audit.log("trainer.app_call", {...})` — two positional arguments against a one-object
 * signature — so `action` arrived `undefined`. `action` is `varchar(100) NOT NULL`, the insert
 * failed, and because `flush()` writes the entire buffer in ONE statement, the whole batch
 * failed with it. The `catch` re-queued everything, so the poison row came back every 5
 * seconds and no tool on that instance had its audit persisted again.
 *
 * The plugin's signature was wrong and has been fixed. The engine's part of the defect is
 * independent of that plugin: any plugin can produce an un-insertable entry, and the audit
 * trail is a compliance surface.
 */

const voce = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  instanceId: "istanza" as InstanceSlug,
  toolName: "unTool",
  action: "test.action",
  ...over,
});

/** A db that records what it was asked to insert, and can refuse chosen rows. */
function db(rifiuta: (entries: AuditEntry[]) => boolean = () => false) {
  const scritte: AuditEntry[][] = [];
  return {
    scritte,
    insert: () => ({
      values: async (v: unknown) => {
        const entries = v as AuditEntry[];
        if (rifiuta(entries)) throw new Error("null value in column \"action\"");
        scritte.push(entries);
      },
    }),
  };
}

describe("AuditStore", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    // The store is a module singleton, so a leftover entry would make the NEXT test pass (or
    // fail) for the wrong reason. Stop this test's interval first, then drain what is left
    // into a throwaway db, then stop that one too: `initialize()` starts an interval every
    // time it is called, and only the most recent one is reachable to be cleared.
    await auditStore.shutdown();
    auditStore.initialize(db() as never);
    await auditStore.flush();
    await auditStore.shutdown();
    vi.restoreAllMocks();
  });

  it("drops an entry with no `action` at the door, naming the tool", () => {
    // It is not buffered at all: an entry that cannot be inserted has exactly one possible
    // future, and that is poisoning everybody else's batch.
    const d = db();
    auditStore.initialize(d as never);
    auditStore.record(voce({ action: undefined as unknown as string, toolName: "pluginRotto" }));
    auditStore.record(voce({ action: "   " }));

    expect(console.warn).toHaveBeenCalledTimes(2);
    expect(String((console.warn as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0]))
      .toContain("pluginRotto");
  });

  it("truncates an over-long `action` instead of dropping the row", async () => {
    // `varchar(100)`: truncating keeps what the row means, dropping it does not.
    const d = db();
    auditStore.initialize(d as never);
    auditStore.record(voce({ action: "a".repeat(250) }));
    await auditStore.flush();

    expect(d.scritte[0]![0]!.action).toHaveLength(100);
  });

  it("a poison row does not take the whole batch with it", async () => {
    /**
     * The heart of the defect. This poison row passes the check at the door — it HAS an
     * `action` — and is refused by the database, for a constraint this process does not know
     * about. The well-formed rows must still reach the table, and the poison row must NOT go
     * back into the buffer: going back into the buffer means being retried every 5 seconds,
     * forever, taking every later entry down with it.
     */
    const d = db((entries) => entries.some((e) => e.action === "veleno"));
    auditStore.initialize(d as never);
    auditStore.record(voce({ action: "buona.1" }));
    auditStore.record(voce({ action: "veleno" }));
    auditStore.record(voce({ action: "buona.2" }));
    await auditStore.flush();

    const scritte = d.scritte.flat().map((e) => e.action);
    expect(scritte).toEqual(["buona.1", "buona.2"]);

    // The assertion that matters: a second flush writes nothing, because nothing is left.
    await auditStore.flush();
    expect(d.scritte.flat().map((e) => e.action)).toEqual(["buona.1", "buona.2"]);
    expect(console.warn).toHaveBeenCalled();
  });

  it("a database that is down loses nothing: every entry stays for the next tick", async () => {
    // The opposite case, which needs the opposite handling. Telling the two apart is the whole
    // point of inserting row by row: if NO row goes in, the rows are not the cause.
    const d = db(() => true);
    auditStore.initialize(d as never);
    auditStore.record(voce({ action: "buona.1" }));
    auditStore.record(voce({ action: "buona.2" }));
    await auditStore.flush();
    expect(d.scritte).toHaveLength(0);

    // The database comes back: both entries are still there and get written.
    const buono = db();
    auditStore.initialize(buono as never);
    await auditStore.flush();
    expect(buono.scritte.flat().map((e) => e.action)).toEqual(["buona.1", "buona.2"]);
  });
});
