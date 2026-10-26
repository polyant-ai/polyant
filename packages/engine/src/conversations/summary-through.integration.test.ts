// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `summary_through` places the history window's start (history-window.ts). It
 * must move only with the summary it describes, never twice from the same base,
 * and it must keep naming the same exchanges when room compaction renumbers them.
 */

import { resolveDatabaseAvailability } from "../database/test-db.js";
import { describe, it, expect, afterAll } from "vitest";
import { conversationStore } from "./store.js";
import { asInstanceSlug } from "../instances/identifiers.js";
import { allTenantsScope } from "../authz/scope-filter.js";
import { db } from "../database/client.js";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { HISTORY_READ_LIMIT, planHistoryWindow } from "../history-window.js";

const DB_AVAILABLE = await resolveDatabaseAvailability();
const CID = `itest:summary-through:${Date.now()}`;
const LEGACY = `${CID}:legacy`;
const SNAP = `${CID}:snapshot`;
const RACE = `${CID}:race`;
const PLAN = `${CID}:plan`;
const BACKFILL = `${CID}:backfill`;
const SLUG = asInstanceSlug("itest-summary-through");

/** The summary state a turn reads with its rows (`getHistorySnapshot`). */
async function stateOf(cid: string) {
  const { summary, summaryThrough, userMessageCount } = await conversationStore.getHistorySnapshot(cid, 40);
  return { summary, summaryThrough, userMessageCount };
}

/** Persist `n` user/assistant exchanges (`u0`/`a0` …) on conversation `cid`. */
async function exchanges(cid: string, n: number) {
  for (let i = 0; i < n; i++) {
    await conversationStore.appendMessages(cid, [
      { role: "user", content: `u${i}` },
      { role: "assistant", content: `a${i}` },
    ]);
  }
}

describe("conversation summary marker (integration)", () => {
  afterAll(async () => {
    if (!DB_AVAILABLE) return;
    for (const cid of [CID, LEGACY, SNAP, RACE, PLAN]) {
      await conversationStore.deleteConversation(cid, allTenantsScope("integration test cleanup")).catch(() => {});
    }
    for (let turns = 1; turns <= 26; turns++) {
      for (const systemRows of [false, true]) {
        for (const failedFinal of [0, 1, 2, 3]) {
          await conversationStore
            .deleteConversation(`${BACKFILL}:${turns}:${systemRows}:${failedFinal}`, allTenantsScope("integration test cleanup"))
            .catch(() => {});
        }
      }
    }
  });

  it.skipIf(!DB_AVAILABLE)("moves the marker with the summary once per base, and shifts it on room compaction", async () => {
    await conversationStore.ensureConversation(CID, SLUG);
    await exchanges(CID, 4);

    expect(await conversationStore.updateSummary(CID, "first", { expected: null, through: 2 })).toBe(true);
    // A second refresh planned on the same base lost the race: dropped, not folded twice.
    expect(await conversationStore.updateSummary(CID, "duplicate", { expected: null, through: 2 })).toBe(false);
    expect(await stateOf(CID)).toEqual({
      summary: "first",
      summaryThrough: 2,
      userMessageCount: 4,
    });

    // Compaction removes u0/a0 (one user row): the summary still ends after u1,
    // which is now exchange 1.
    await conversationStore.replaceOldestMessages(CID, 2, "room");
    expect(await stateOf(CID)).toMatchObject({ summaryThrough: 1, userMessageCount: 3 });
  });

  it.skipIf(!DB_AVAILABLE)("leaves a summary an engine without the marker wrote without one through compaction", async () => {
    await conversationStore.ensureConversation(LEGACY, SLUG);
    await exchanges(LEGACY, 3);
    await conversationStore.updateSummary(LEGACY, "legacy");
    await conversationStore.replaceOldestMessages(LEGACY, 2, "room");
    expect(await stateOf(LEGACY)).toMatchObject({ summary: "legacy", summaryThrough: null });
  });

  it.skipIf(!DB_AVAILABLE)("reads the rows with their summary state, and replay columns only for the window", async () => {
    await conversationStore.ensureConversation(SNAP, SLUG);
    const t0 = Date.now() - 60_000;
    for (let i = 0; i < 8; i++) {
      await conversationStore.appendMessages(SNAP, [
        { role: "user", content: `u${i}`, createdAt: new Date(t0 + i * 2000) },
        {
          role: "assistant",
          content: `a${i}`,
          createdAt: new Date(t0 + i * 2000 + 1000),
          steps: [{ stepIndex: i }] as never,
          reasoning: [{ text: `r${i}` }] as never,
        },
      ]);
    }
    const all = Array.from({ length: 8 }, (_, i) => [`u${i}`, `a${i}`]).flat();

    // No marker yet: the whole read is the window.
    let replay = await conversationStore.getHistorySnapshot(SNAP, 40, { steps: true });
    expect(replay.rows.map((r) => r.content)).toEqual(all);
    expect(replay.rows.filter((r) => r.steps).map((r) => r.content)).toEqual(all.filter((c) => c.startsWith("a")));

    expect(await conversationStore.updateSummary(SNAP, "s", { expected: null, through: 5 })).toBe(true);
    const text = await conversationStore.getHistorySnapshot(SNAP, 6);
    expect(text.rows.map((r) => r.content)).toEqual(["u5", "a5", "u6", "a6", "u7", "a7"]);
    expect(text.rows[1]).not.toHaveProperty("steps");
    expect(text).toMatchObject({ summary: "s", summaryThrough: 5, userMessageCount: 8 });

    // Marker at 5: exchanges 5..7 are the window; older rows come without the replay columns.
    replay = await conversationStore.getHistorySnapshot(SNAP, 40, { steps: true });
    expect(replay.rows.map((r) => r.content)).toEqual(all);
    expect(replay.rows.filter((r) => r.steps).map((r) => r.content)).toEqual(["a5", "a6", "a7"]);
    expect(replay.rows.filter((r) => r.reasoning).map((r) => r.content)).toEqual(["a5", "a6", "a7"]);
    expect(replay.rows.find((r) => r.content === "a7")?.steps).toEqual([{ stepIndex: 7 }]);
    expect(replay.rows.find((r) => r.content === "a7")?.reasoning).toEqual([{ text: "r7" }]);
    expect(await conversationStore.getHistorySnapshot(`${SNAP}:none`, 40)).toEqual({
      rows: [],
      summary: null,
      summaryThrough: null,
      userMessageCount: null,
    });
  });

  it.skipIf(!DB_AVAILABLE)("never returns a count out of step with the rows while turns land", async () => {
    await conversationStore.ensureConversation(RACE, SLUG);
    let landed = false;
    const turns = (async () => {
      await exchanges(RACE, 25);
    })().finally(() => {
      landed = true;
    });
    let reads = 0;
    while (!landed) {
      const snap = await conversationStore.getHistorySnapshot(RACE, 1000);
      const users = snap.rows.filter((r) => r.role === "user").length;
      if (snap.rows.length > 0) expect(snap.userMessageCount).toBe(users);
      reads++;
    }
    await turns;
    expect(reads).toBeGreaterThan(0);
    expect((await stateOf(RACE)).userMessageCount).toBe(25);
  });

  it.skipIf(!DB_AVAILABLE)("backfills a marker no later than the old summary's coverage, through two failed final refreshes", async () => {
    // The backfill statement migration 0097 runs, limited to this test's conversations.
    const migration = readFileSync(new URL("../database/migrations/0097_conversation_summary_through.sql", import.meta.url), "utf8");
    const backfill = migration.slice(migration.indexOf("UPDATE")).trim().replace(/;$/, "");
    type Row = { role: string; content: string };
    let lossCases = 0;
    let cases = 0;
    for (let turns = 1; turns <= 26; turns++) {
      for (const systemRows of [false, true]) {
        for (const failedFinal of [0, 1, 2, 3]) {
          // The window before the marker (pipeline.ts up to 8b6f76f9), turn by turn: read the last 16
          // rows and, past 15, fold all but the last 10 into the summary. The last `failedFinal`
          // refreshes fail, so the summary keeps the previous turn's coverage.
          const rows: Row[] = [];
          const folded = new Set<string>();
          for (let i = 0; i < turns; i++) {
            const read = rows.slice(-16);
            if (read.length > 15 && i < turns - failedFinal) for (const r of read.slice(0, -10)) folded.add(r.content);
            if (systemRows && i % 3 === 1) rows.push({ role: "system", content: `s${i}` });
            rows.push({ role: "user", content: `u${i}` }, { role: "assistant", content: `a${i}` });
          }
          const cid = `${BACKFILL}:${turns}:${systemRows}:${failedFinal}`;
          await conversationStore.ensureConversation(cid, SLUG);
          const t0 = Date.now() - 3_600_000;
          await conversationStore.appendMessages(cid, rows.map((r, i) => ({ ...r, createdAt: new Date(t0 + i * 1000) })));
          if (folded.size > 0) await conversationStore.updateSummary(cid, "old summary");
        }
      }
    }
    // Run twice: the second run finds no unmarked summary and changes nothing.
    await db.execute(sql.raw(`${backfill} AND "conversation_id" LIKE '${BACKFILL}:%'`));
    const again = await db.execute(sql.raw(`${backfill} AND "conversation_id" LIKE '${BACKFILL}:%' RETURNING 1`));
    expect((again as unknown as unknown[]).length).toBe(0);

    for (let turns = 1; turns <= 26; turns++) {
      for (const systemRows of [false, true]) {
        for (const failedFinal of [0, 1, 2, 3]) {
          const rows: Row[] = [];
          const folded = new Set<string>();
          for (let i = 0; i < turns; i++) {
            const read = rows.slice(-16);
            if (read.length > 15 && i < turns - failedFinal) for (const r of read.slice(0, -10)) folded.add(r.content);
            if (systemRows && i % 3 === 1) rows.push({ role: "system", content: `s${i}` });
            rows.push({ role: "user", content: `u${i}` }, { role: "assistant", content: `a${i}` });
          }
          const snap = await conversationStore.getHistorySnapshot(`${BACKFILL}:${turns}:${systemRows}:${failedFinal}`, HISTORY_READ_LIMIT);
          expect(snap.summaryThrough).toBe(folded.size > 0 ? Math.max(turns - 8, 0) : null);
          // The old window would still have folded every row of its next read: only older unfolded rows were lost there.
          const oldLost = rows.slice(0, -16).filter((r) => r.role === "user" && !folded.has(r.content)).map((r) => r.content);
          for (const blockExchanges of [5, 1]) {
            const plan = planHistoryWindow(snap.rows, {
              blockExchanges,
              userMessageCount: snap.userMessageCount ?? undefined,
              summaryThrough: snap.summaryThrough,
            });
            const seen = new Set(snap.rows.slice(plan.start).map((r) => r.content));
            const missing = rows.filter((r) => r.role === "user" && !seen.has(r.content) && !folded.has(r.content)).map((r) => r.content);
            const shape = { turns, systemRows, failedFinal, blockExchanges };
            if (failedFinal <= 2) {
              expect({ ...shape, missing }).toEqual({ ...shape, missing: [] });
            } else {
              // A third failed refresh loses no exchange the old window had not already lost.
              expect({ ...shape, extra: missing.filter((c) => !oldLost.includes(c)) }).toEqual({ ...shape, extra: [] });
              if (missing.length > 0) lossCases++;
            }
            cases++;
          }
        }
      }
    }
    expect(cases).toBe(26 * 2 * 4 * 2);
    // The k=3 limit is real: some conversations lose the exchange the old window lost.
    expect(lossCases).toBeGreaterThan(0);
  });

  it.skipIf(!DB_AVAILABLE)("gives every row the planned window holds its replay columns, whatever the stored state", async () => {
    // A greeting row before the first user row, then 8 exchanges; every assistant row has steps.
    await conversationStore.ensureConversation(PLAN, SLUG);
    const t0 = Date.now() - 60_000;
    const step = (c: string) => ({ steps: [{ stepIndex: c }] as never, reasoning: [{ text: c }] as never });
    await conversationStore.appendMessages(PLAN, [
      { role: "assistant", content: "greeting", createdAt: new Date(t0 - 1000), ...step("greeting") },
    ]);
    for (let i = 0; i < 8; i++) {
      await conversationStore.appendMessages(PLAN, [
        { role: "user", content: `u${i}`, createdAt: new Date(t0 + i * 2000) },
        { role: "assistant", content: `a${i}`, createdAt: new Date(t0 + i * 2000 + 1000), ...step(`a${i}`) },
      ]);
    }
    const shapes: Record<string, { summary: string | null; through: number | null; count: number }> = {
      "marker inside the count": { summary: "s", through: 5, count: 8 },
      "stored count below the user rows": { summary: "s", through: 3, count: 6 },
      "marker 0 (room compaction)": { summary: "s", through: 0, count: 8 },
      "summary without a marker": { summary: "s", through: null, count: 8 },
      "marker past the count": { summary: "s", through: 12, count: 8 },
      "no summary": { summary: null, through: null, count: 8 },
    };
    for (const [shape, state] of Object.entries(shapes)) {
      await db.execute(sql`UPDATE conversations SET summary = ${state.summary}, summary_through = ${state.through},
        user_message_count = ${state.count} WHERE conversation_id = ${PLAN}`);
      const snap = await conversationStore.getHistorySnapshot(PLAN, HISTORY_READ_LIMIT, { steps: true });
      for (const blockExchanges of [5, 1]) {
        // The inputs preparePipeline plans the window on (pipeline.ts).
        const plan = planHistoryWindow(snap.rows, {
          blockExchanges,
          userMessageCount: snap.userMessageCount ?? undefined,
          summaryThrough: snap.summaryThrough,
        });
        const window = snap.rows.slice(plan.start);
        expect(window.length).toBeGreaterThan(0);
        const missing = window.filter((r) => r.role === "assistant" && (!r.steps || !r.reasoning)).map((r) => r.content);
        expect({ shape, blockExchanges, missing }).toEqual({ shape, blockExchanges, missing: [] });
      }
    }
  });
});
