// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { asInstanceSlug } from "../instances/identifiers.js";

// Chain proxy helper: await returns resolvedValue, every chained method keeps the chain.
function createChainMock(resolvedValue: unknown = []) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const self = new Proxy(chain, {
    get(_target, prop: string) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => resolve(resolvedValue);
      }
      if (!chain[prop]) {
        chain[prop] = vi.fn(() => self);
      }
      return chain[prop];
    },
  });
  return self;
}

const { mockDb } = vi.hoisted(() => {
  const mockDb = {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  };
  mockDb.transaction.mockImplementation(
    async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb),
  );
  return { mockDb };
});

vi.mock("../database/client.js", () => ({ db: mockDb }));

import {
  appendAgentDocument,
  upsertAgentDocument,
  DocumentSizeExceededError,
  MAX_DOCUMENT_BYTES,
  MAX_WRITE_BYTES,
} from "./store.js";

beforeEach(() => {
  vi.clearAllMocks();
  // re-install the transaction implementation (clearAllMocks resets it)
  mockDb.transaction.mockImplementation(
    async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb),
  );
});

describe("upsertAgentDocument", () => {
  it("creates a new doc when no existing row is found", async () => {
    mockDb.select.mockReturnValue(createChainMock([])); // SELECT FOR UPDATE returns empty
    mockDb.insert.mockReturnValue(createChainMock([{ id: "doc-new" }])); // INSERT RETURNING id

    const result = await upsertAgentDocument({
      instanceId: asInstanceSlug("inst-1"),
      filename: "a.md",
      content: "hello",
    });

    expect(result).toMatchObject({
      docId: "doc-new",
      created: true,
      sizeBytes: 5,
      rawContent: "hello",
    });
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it("updates the existing doc when a row with the same (instance, filename) exists", async () => {
    mockDb.select.mockReturnValue(createChainMock([{ id: "doc-existing" }]));
    mockDb.update.mockReturnValue(createChainMock([]));

    const result = await upsertAgentDocument({
      instanceId: asInstanceSlug("inst-1"),
      filename: "a.md",
      content: "overwrite",
    });

    expect(result).toMatchObject({
      docId: "doc-existing",
      created: false,
      sizeBytes: 9,
      rawContent: "overwrite",
    });
    expect(mockDb.update).toHaveBeenCalled();
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("rejects input larger than MAX_WRITE_BYTES", async () => {
    const big = "x".repeat(MAX_WRITE_BYTES + 1);
    await expect(
      upsertAgentDocument({ instanceId: asInstanceSlug("inst-1"), filename: "x.md", content: big }),
    ).rejects.toBeInstanceOf(DocumentSizeExceededError);
  });
});

describe("appendAgentDocument", () => {
  it("creates a fresh doc when target does not exist (no separator)", async () => {
    mockDb.select.mockReturnValue(createChainMock([]));
    mockDb.insert.mockReturnValue(createChainMock([{ id: "doc-new" }]));

    const result = await appendAgentDocument({
      instanceId: asInstanceSlug("inst-1"),
      filename: "log.md",
      content: "first",
    });

    expect(result.created).toBe(true);
    expect(result.rawContent).toBe("first");
    expect(result.sizeBytes).toBe(5);
  });

  it("appends with double-newline separator when the doc exists", async () => {
    mockDb.select.mockReturnValue(
      createChainMock([{ id: "doc-1", rawContent: "A" }]),
    );
    mockDb.update.mockReturnValue(createChainMock([]));

    const result = await appendAgentDocument({
      instanceId: asInstanceSlug("inst-1"),
      filename: "log.md",
      content: "B",
    });

    expect(result).toMatchObject({
      docId: "doc-1",
      created: false,
      rawContent: "A\n\nB",
      sizeBytes: 4,
    });
  });

  it("rejects append that would exceed MAX_DOCUMENT_BYTES", async () => {
    const existingLen = MAX_DOCUMENT_BYTES - 10;
    mockDb.select.mockReturnValue(
      createChainMock([{ id: "doc-1", rawContent: "x".repeat(existingLen) }]),
    );

    await expect(
      appendAgentDocument({
        instanceId: asInstanceSlug("inst-1"),
        filename: "big.md",
        content: "x".repeat(100), // 100 bytes + \n\n = 102 → well over the 10-byte headroom
      }),
    ).rejects.toBeInstanceOf(DocumentSizeExceededError);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("rejects a single chunk larger than MAX_WRITE_BYTES", async () => {
    await expect(
      appendAgentDocument({
        instanceId: asInstanceSlug("inst-1"),
        filename: "x.md",
        content: "x".repeat(MAX_WRITE_BYTES + 1),
      }),
    ).rejects.toBeInstanceOf(DocumentSizeExceededError);
  });
});
