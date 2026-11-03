// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { asInstanceSlug } from "../../instances/identifiers.js";
import { createAuditLogger } from "../../audit/audit-logger.js";
import { auditStore, type AuditEntry } from "../../audit/audit.store.js";

// The turn's preflight resolves the agent's configuration; doubled here, the real resolver opens a database connection.
vi.mock("../../instances/config-resolver.js", () => ({
  resolveInstanceConfig: vi.fn(async () => ({ providerRefusal: null, tierModels: {} })),
  invalidateInstanceConfigCache: vi.fn(),
}));

/**
 * A tool call's audit row carries the duration and output of THAT call. Two conversations
 * calling the same tool at the same time used to swap them, and a row left without output
 * received the output of the next call of the same tool, in any conversation.
 */

const agent = asInstanceSlug("agent");

function recordingDb() {
  const written: AuditEntry[] = [];
  return {
    written,
    insert: () => ({
      values: async (rows: unknown) => {
        written.push(...(rows as AuditEntry[]));
      },
    }),
  };
}

/** A tool that writes one audit row, then waits for the test to let it finish with `output`. */
function heldTool(conversationId: string) {
  let release!: (output: unknown) => void;
  const done = new Promise<unknown>((resolve) => (release = resolve));
  const audit = createAuditLogger("lookup", agent, conversationId);
  return {
    release,
    tool: {
      execute: async () => {
        audit.log({ action: "lookup", details: { conversationId } });
        return done;
      },
    },
  };
}

async function wrap(tool: { execute: (...args: unknown[]) => Promise<unknown> }, conversationId: string) {
  const { wrapToolWithAudit } = await import("./index.js");
  return wrapToolWithAudit("lookup", tool as never, agent, conversationId, []);
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("wrapToolWithAudit — the audit row of a tool call", () => {
  let db: ReturnType<typeof recordingDb>;
  beforeEach(() => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    db = recordingDb();
    auditStore.initialize(db as never);
  });
  afterEach(async () => {
    await auditStore.shutdown();
    vi.restoreAllMocks();
  });

  it("keeps each conversation's output on its own row when two calls overlap", async () => {
    const a = heldTool("conv-A");
    const b = heldTool("conv-B");
    const runA = (await wrap(a.tool, "conv-A")).execute!({}, {} as never);
    const runB = (await wrap(b.tool, "conv-B")).execute!({}, {} as never);
    await tick();

    // A finishes first, while B's row is the newest one waiting.
    a.release({ result: "output of A" });
    await runA;
    b.release({ result: "output of B" });
    await runB;
    await auditStore.flush();

    const row = (conv: string) => db.written.find((e) => e.conversationId === conv);
    expect(row("conv-A")?.output).toContain("output of A");
    expect(row("conv-B")?.output).toContain("output of B");
    expect(row("conv-A")?.durationMs).toEqual(expect.any(Number));
    expect(row("conv-B")?.durationMs).toEqual(expect.any(Number));
  });

  it("never gives a row the output of a later call in another conversation", async () => {
    // C's tool writes its row and returns nothing worth keeping; D's tool writes no row.
    const c = (await wrap({ execute: async () => {
      createAuditLogger("lookup", agent, "conv-C").log({ action: "lookup" });
      return null;
    } }, "conv-C")).execute!({}, {} as never);
    await c;
    await (await wrap({ execute: async () => ({ page: "content of D" }) }, "conv-D")).execute!({}, {} as never);
    await auditStore.flush();

    expect(db.written).toHaveLength(1);
    expect(db.written[0]!.conversationId).toBe("conv-C");
    expect(db.written[0]!.output).toBeUndefined();
  });

  it("writes duration and output even when the buffer was flushed while the tool ran", async () => {
    const e = heldTool("conv-E");
    const run = (await wrap(e.tool, "conv-E")).execute!({}, {} as never);
    await tick();
    await auditStore.flush();
    e.release({ result: "output of E" });
    await run;
    await auditStore.flush();

    expect(db.written).toHaveLength(1);
    expect(db.written[0]!.output).toContain("output of E");
    expect(db.written[0]!.durationMs).toEqual(expect.any(Number));
  });

  it("stamps the row with the moment the tool recorded it", async () => {
    const before = Date.now();
    await (await wrap({ execute: async () => {
      createAuditLogger("lookup", agent, "conv-F").log({ action: "lookup" });
      return { ok: true };
    } }, "conv-F")).execute!({}, {} as never);
    const after = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await auditStore.flush();

    const createdAt = (db.written[0] as AuditEntry & { createdAt?: Date }).createdAt;
    expect(createdAt).toBeInstanceOf(Date);
    expect(createdAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(createdAt!.getTime()).toBeLessThanOrEqual(after);
  });
});
