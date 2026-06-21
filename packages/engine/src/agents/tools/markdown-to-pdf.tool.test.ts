// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeAll } from "vitest";
import { Semaphore } from "./markdown-to-pdf.tool.js";
import { loadAllTools, getToolRegistry, type ToolContext } from "./registry.js";
import { createMockAudit } from "../../test-utils.js";
import { asAgentSlug } from "../../instances/identifiers.js";

// Pause a microtask so any pending acquire() Promises get a chance to run.
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("Semaphore", () => {
  it("rejects non-positive permits", () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(-1)).toThrow();
    expect(() => new Semaphore(1.5)).toThrow();
  });

  it("acquire returns immediately while permits are available", async () => {
    const s = new Semaphore(2);
    await s.acquire();
    await s.acquire();
    expect(s.stats()).toEqual({ available: 0, capacity: 2, waiting: 0 });
  });

  it("blocks beyond capacity and resumes on release (FIFO)", async () => {
    const s = new Semaphore(2);
    const completed: number[] = [];

    const task = async (id: number) => {
      await s.acquire();
      completed.push(id);
    };

    void task(1);
    void task(2);
    void task(3);
    void task(4);

    await tick();
    // Only the first 2 should have made it past acquire().
    expect(completed).toEqual([1, 2]);
    expect(s.stats().waiting).toBe(2);

    // Release one — task(3) wakes.
    s.release();
    await tick();
    expect(completed).toEqual([1, 2, 3]);
    expect(s.stats().waiting).toBe(1);

    // Release another — task(4) wakes.
    s.release();
    await tick();
    expect(completed).toEqual([1, 2, 3, 4]);
    expect(s.stats().waiting).toBe(0);
  });

  it("recovers the permit when the critical section throws (try/finally)", async () => {
    const s = new Semaphore(1);

    async function critical(shouldThrow: boolean): Promise<void> {
      await s.acquire();
      try {
        if (shouldThrow) throw new Error("boom");
      } finally {
        s.release();
      }
    }

    await expect(critical(true)).rejects.toThrow("boom");
    // Permit must be free again — otherwise the second call would hang.
    expect(s.stats().available).toBe(1);
    await critical(false);
    expect(s.stats().available).toBe(1);
  });

  it("release without contention never overshoots capacity", () => {
    const s = new Semaphore(2);
    // Spurious releases (defensive — never expected in practice) must not
    // push `available` above `capacity`.
    s.release();
    s.release();
    s.release();
    s.release();
    expect(s.stats().available).toBe(2);
  });

  it("caps real concurrent operations (integration-style)", async () => {
    const s = new Semaphore(3);
    let active = 0;
    let peak = 0;
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    async function run() {
      await s.acquire();
      try {
        active++;
        if (active > peak) peak = active;
        await wait(20);
      } finally {
        active--;
        s.release();
      }
    }

    await Promise.all(Array.from({ length: 10 }, () => run()));
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThanOrEqual(2); // sanity: some parallelism happened
    expect(active).toBe(0);
    expect(s.stats()).toEqual({ available: 3, capacity: 3, waiting: 0 });
  });
});

function stubCtx(): ToolContext {
  return {
    agentId: asAgentSlug("markdown-to-pdf-test"),
    secrets: {},
    audit: createMockAudit(),
    conversationId: "markdown-to-pdf-test-conv",
    attachments: [],
    provider: "openai",
  };
}

async function executeTool(input: Record<string, unknown>) {
  const def = getToolRegistry().get("markdownToPdf");
  if (!def) throw new Error("tool not registered");
  const built = def.create(stubCtx());
  return built.execute(input as never) as Promise<Record<string, unknown>>;
}

describe("markdownToPdf — input validation", () => {
  beforeAll(async () => {
    await loadAllTools();
  });

  it("rejects markdown over the size cap", async () => {
    const result = await executeTool({
      markdown: "x".repeat(100_001),
      filename: "test",
      headerImageUrl: null,
    });
    expect(result.error).toContain("Markdown too long");
  });

  it("rejects a non-https headerImageUrl", async () => {
    const result = await executeTool({
      markdown: "# Test",
      filename: "test",
      headerImageUrl: "http://insecure.example.com/logo.png",
    });
    expect(result.error).toContain("https");
  });
});
