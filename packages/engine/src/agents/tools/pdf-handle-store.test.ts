// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, afterAll } from "vitest";
import { pdfHandleStore } from "./pdf-handle-store.js";

afterAll(() => {
  pdfHandleStore.stopCleanupTimer();
});

describe("PdfHandleStore", () => {
  it("put returns a unique handle starting with 'pdf_'", () => {
    const a = pdfHandleStore.put(Buffer.from("a"), "a.pdf", "application/pdf");
    const b = pdfHandleStore.put(Buffer.from("b"), "b.pdf", "application/pdf");
    expect(a).toMatch(/^pdf_/);
    expect(b).toMatch(/^pdf_/);
    expect(a).not.toBe(b);
  });

  it("take returns the entry once then removes it (one-shot)", () => {
    const handle = pdfHandleStore.put(Buffer.from("hello"), "x.pdf", "application/pdf");
    const first = pdfHandleStore.take(handle);
    expect(first?.buffer.toString()).toBe("hello");
    expect(first?.filename).toBe("x.pdf");
    expect(first?.mime).toBe("application/pdf");

    const second = pdfHandleStore.take(handle);
    expect(second).toBeNull();
  });

  it("take returns null for unknown handle", () => {
    expect(pdfHandleStore.take("pdf_does-not-exist")).toBeNull();
  });

  it("take returns null and removes the entry when expired", () => {
    const handle = pdfHandleStore.put(Buffer.from("x"), "x.pdf", "application/pdf", -1);
    const result = pdfHandleStore.take(handle);
    expect(result).toBeNull();
  });

  it("cleanup removes expired entries", () => {
    pdfHandleStore.put(Buffer.from("x"), "x.pdf", "application/pdf", -1);
    pdfHandleStore.put(Buffer.from("y"), "y.pdf", "application/pdf", -1);
    const fresh = pdfHandleStore.put(Buffer.from("z"), "z.pdf", "application/pdf");

    const removed = pdfHandleStore.cleanup();
    expect(removed).toBeGreaterThanOrEqual(2);
    // Fresh handle still consumable
    expect(pdfHandleStore.take(fresh)?.buffer.toString()).toBe("z");
  });
});
