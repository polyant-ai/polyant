// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for the read-then-write transactionality of `setChannelConfig`'s
 * WhatsApp apiKey-mode carry-forward path (#279). Split out of
 * `channels.store.whatsapp.test.ts` to keep that file under the ≤400-line
 * rule — self-contained with its own mocks.
 *
 * A real concurrent race cannot be reproduced in a unit test — these tests
 * pin the MECHANISM (the carry-forward read runs inside the same transaction
 * as the upsert and takes a row lock), not the race itself.
 */

// ---------------------------------------------------------------------------
// Chain mock helper (read side)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { mockDb, mockEncrypt, mockDecrypt, mockGenerateToken } = vi.hoisted(() => {
  let tokenCounter = 0;
  const mockDb = {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  };
  const mockEncrypt = vi.fn((v: string) => `encrypted:${v}`);
  const mockDecrypt = vi.fn((v: string) => v.replace("encrypted:", ""));
  const mockGenerateToken = vi.fn(() => (++tokenCounter).toString(16).padStart(64, "0"));
  return { mockDb, mockEncrypt, mockDecrypt, mockGenerateToken };
});

vi.mock("../database/client.js", () => ({ db: mockDb }));

vi.mock("../crypto/index.js", () => ({
  encrypt: mockEncrypt,
  decrypt: mockDecrypt,
  generateToken: mockGenerateToken,
}));

vi.mock("./schema.js", () => ({
  instances: { id: "id", slug: "slug" },
}));

vi.mock("./channels.schema.js", () => ({
  instanceChannels: {
    id: "id",
    instanceId: "instance_id",
    channelType: "channel_type",
    enabled: "enabled",
    config: "config",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ type: "eq", args })),
  and: vi.fn((...args: unknown[]) => ({ type: "and", args })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks) -- zod is NOT mocked
// ---------------------------------------------------------------------------
import { setChannelConfig } from "./channels.store.js";
import { asInstanceUuid } from "./identifiers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const INSTANCE_UUID = asInstanceUuid("uuid-instance-1");
const ACCOUNT_SID = "AC00000000000000000000000000000001";
const API_KEY_SID = "SK00000000000000000000000000000002";
const NUMBER = "+14155238886";

/** The one row `setChannelConfig` reads/writes in these tests, faking real persistence. */
let storedRow: { config: string } | null = null;

function seedStoredRow(config: Record<string, unknown>): void {
  storedRow = { config: `encrypted:${JSON.stringify(config)}` };
}

/** The most recent chain object returned by `mockDb.select`, so a test can inspect e.g. `.for(...)`. */
let lastSelectChain: ReturnType<typeof createChainMock> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  storedRow = null;
  lastSelectChain = undefined;
  mockDb.select.mockImplementation(() => {
    lastSelectChain = createChainMock(storedRow ? [{ config: storedRow.config }] : []);
    return lastSelectChain;
  });
  mockDb.insert.mockImplementation(() => {
    const chain: Record<string, unknown> = {};
    chain.values = vi.fn((values: { config: string }) => {
      storedRow = { config: values.config };
      return chain;
    });
    chain.onConflictDoUpdate = vi.fn(() => chain);
    return chain;
  });
  // Real `db.transaction` hands the callback a tx client; the fake here hands
  // it the SAME `mockDb` so `select`/`insert` inside the callback are the
  // exact spies these tests already assert on.
  mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb));
});

describe("instances/channels.store — read-then-write transactionality (carry-forward path)", () => {
  it("wraps the carry-forward read and the upsert in one db.transaction, with a row lock on the read", async () => {
    seedStoredRow({
      authMode: "apiKey",
      accountSid: ACCOUNT_SID,
      apiKeySid: API_KEY_SID,
      apiKeySecret: "sec",
      webhookSecret: "keep-me",
      whatsappNumber: NUMBER,
    });

    await setChannelConfig(
      INSTANCE_UUID,
      "whatsapp",
      {
        authMode: "apiKey",
        accountSid: ACCOUNT_SID,
        apiKeySid: API_KEY_SID,
        apiKeySecret: "sec",
        whatsappNumber: "+19998887777",
      },
      true,
    );

    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    // The read that carries the secret forward must take a row lock ...
    expect(lastSelectChain?.for).toHaveBeenCalledWith("update");
    // ... and both the read and the write must happen INSIDE the
    // transaction (i.e. after `db.transaction` was invoked), not before it.
    const txOrder = mockDb.transaction.mock.invocationCallOrder[0];
    const selectOrder = mockDb.select.mock.invocationCallOrder[0];
    const insertOrder = mockDb.insert.mock.invocationCallOrder[0];
    expect(selectOrder).toBeGreaterThan(txOrder);
    expect(insertOrder).toBeGreaterThan(txOrder);
  });

  it("also wraps the first-ever mint (no prior row) in the same transaction", async () => {
    await setChannelConfig(
      INSTANCE_UUID,
      "whatsapp",
      { authMode: "apiKey", accountSid: ACCOUNT_SID, apiKeySid: API_KEY_SID, apiKeySecret: "sec", whatsappNumber: NUMBER },
      true,
    );

    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(lastSelectChain?.for).toHaveBeenCalledWith("update");
  });

  it("does NOT open a transaction for a rotation (no carry-forward read to protect)", async () => {
    seedStoredRow({
      authMode: "apiKey",
      accountSid: ACCOUNT_SID,
      apiKeySid: API_KEY_SID,
      apiKeySecret: "sec",
      webhookSecret: "old-secret",
      whatsappNumber: NUMBER,
    });

    await setChannelConfig(
      INSTANCE_UUID,
      "whatsapp",
      { authMode: "apiKey", accountSid: ACCOUNT_SID, apiKeySid: API_KEY_SID, apiKeySecret: "sec", whatsappNumber: NUMBER },
      true,
      { rotateWebhookSecretTo: "explicit-rotated-value" },
    );

    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it("does NOT open a transaction for an authToken-mode save", async () => {
    await setChannelConfig(
      INSTANCE_UUID,
      "whatsapp",
      { authMode: "authToken", accountSid: ACCOUNT_SID, authToken: "tok", whatsappNumber: NUMBER },
      true,
    );

    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});
