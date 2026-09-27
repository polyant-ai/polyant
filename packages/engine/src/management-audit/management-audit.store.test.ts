// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for the OSS management-plane write-audit store + logger.
 *
 * The store buffers destructive management mutations and flushes them to the
 * `management_audit_logs` table. The logger is the thin, caller-facing API that
 * records one row per mutation with actor + target + action.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ManagementAuditStore } from "./management-audit.store.js";
import {
  createManagementAuditLogger,
  ManagementAuditAction,
} from "./management-audit-logger.js";

/** Minimal stub matching the store's InsertableDb shape. */
function createInsertSpy() {
  const captured: unknown[] = [];
  const db = {
    insert(_table: unknown) {
      return {
        async values(v: unknown) {
          captured.push(v);
        },
      };
    },
  };
  return { db, captured };
}

describe("ManagementAuditStore", () => {
  let store: ManagementAuditStore;

  beforeEach(() => {
    store = new ManagementAuditStore();
  });

  it("flushes a buffered entry to the table on flush()", async () => {
    const { db, captured } = createInsertSpy();
    store.initialize(db);

    store.record({
      action: ManagementAuditAction.AgentDelete,
      actorUserId: "user-1",
      actorEmail: "admin@example.com",
      targetType: "agent",
      targetId: "my-agent",
    });

    await store.flush();

    expect(captured).toHaveLength(1);
    const rows = captured[0] as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({
      action: "agent.delete",
      actorUserId: "user-1",
      actorEmail: "admin@example.com",
      targetType: "agent",
      targetId: "my-agent",
    });
  });

  it("auto-flushes once the batch threshold is reached", async () => {
    const { db, captured } = createInsertSpy();
    store.initialize(db);

    for (let i = 0; i < 10; i++) {
      store.record({
        action: ManagementAuditAction.SecretWrite,
        actorUserId: null,
        actorEmail: null,
        targetType: "secret",
        targetId: `key-${i}`,
      });
    }
    // The auto-flush is async; let microtasks settle.
    await Promise.resolve();
    await Promise.resolve();

    const total = captured.reduce<number>(
      (n, batch) => n + (batch as unknown[]).length,
      0,
    );
    expect(total).toBe(10);
  });

  it("never throws when no db is initialized (boot-order safety)", async () => {
    store.record({
      action: ManagementAuditAction.MemberRemove,
      actorUserId: null,
      actorEmail: null,
      targetType: "member",
      targetId: "user-2",
    });
    await expect(store.flush()).resolves.toBeUndefined();
  });

  it("re-buffers entries when the insert fails, capped to MAX_BUFFER_SIZE", async () => {
    const failingDb = {
      insert() {
        return {
          values() {
            return Promise.reject(new Error("db down"));
          },
        };
      },
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    store.initialize(failingDb);
    store.record({
      action: ManagementAuditAction.AgentCreate,
      actorUserId: null,
      actorEmail: null,
      targetType: "agent",
      targetId: "x",
    });

    await store.flush();

    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  /** A database that refuses any row whose targetId is `poison`, as Postgres refuses a value its column cannot hold. */
  function refusingDb() {
    const written: Array<Record<string, unknown>> = [];
    let up = true;
    const db = {
      insert() {
        return {
          async values(rows: Array<Record<string, unknown>>) {
            if (!up) throw new Error("db down");
            if (rows.some((r) => r.targetId === "poison")) throw new Error("value refused");
            written.push(...rows);
          },
        };
      },
    };
    return { db, written, setUp: (value: boolean) => { up = value; } };
  }

  const entry = (targetId: string) => ({
    action: ManagementAuditAction.AgentCreate,
    actorUserId: null,
    actorEmail: null,
    targetType: "agent",
    targetId,
  });

  it("writes the other rows of a batch and drops only the one the database refuses", async () => {
    const { db, written } = refusingDb();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    store.initialize(db);
    store.record(entry("a"));
    store.record(entry("poison"));
    store.record(entry("b"));

    await store.flush();
    store.record(entry("c"));
    await store.flush();

    expect(written.map((r) => r.targetId)).toEqual(["a", "b", "c"]);
    errSpy.mockRestore();
  });

  it("keeps the whole batch for later when the database itself is down", async () => {
    const { db, written, setUp } = refusingDb();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    store.initialize(db);
    store.record(entry("a"));
    store.record(entry("b"));

    setUp(false);
    await store.flush();
    setUp(true);
    await store.flush();

    expect(written.map((r) => r.targetId)).toEqual(["a", "b"]);
    errSpy.mockRestore();
  });

  it("cuts a value longer than its column, so the row can still be written", async () => {
    const { db, captured } = createInsertSpy();
    store.initialize(db);
    store.record(entry("x".repeat(300)));

    await store.flush();

    const [row] = captured[0] as Array<Record<string, string>>;
    expect(row.targetId).toHaveLength(255);
  });
});

describe("createManagementAuditLogger", () => {
  it("records a row carrying actor + target + action", async () => {
    const { db, captured } = createInsertSpy();
    const store = new ManagementAuditStore();
    store.initialize(db);
    const logger = createManagementAuditLogger(store);

    logger.log({
      action: ManagementAuditAction.SecretDelete,
      actor: { userId: "u-9", email: "owner@example.com" },
      targetType: "secret",
      targetId: "openai_api_key",
      metadata: { instanceSlug: "support-bot" },
    });

    await store.flush();

    const rows = captured[0] as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({
      action: "secret.delete",
      actorUserId: "u-9",
      actorEmail: "owner@example.com",
      targetType: "secret",
      targetId: "openai_api_key",
      metadata: { instanceSlug: "support-bot" },
    });
  });

  it("tolerates an undefined actor (gateway mode / unauthenticated edge)", async () => {
    const { db, captured } = createInsertSpy();
    const store = new ManagementAuditStore();
    store.initialize(db);
    const logger = createManagementAuditLogger(store);

    logger.log({
      action: ManagementAuditAction.AgentCreate,
      actor: undefined,
      targetType: "agent",
      targetId: "new-agent",
    });

    await store.flush();

    const rows = captured[0] as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({
      action: "agent.create",
      actorUserId: null,
      actorEmail: null,
      targetType: "agent",
      targetId: "new-agent",
    });
  });
});

describe("ManagementAuditAction", () => {
  it("exposes the five destructive management actions in scope", () => {
    expect(Object.values(ManagementAuditAction)).toEqual(
      expect.arrayContaining([
        "agent.create",
        "agent.delete",
        "secret.write",
        "secret.delete",
        "member.remove",
      ]),
    );
  });
});
