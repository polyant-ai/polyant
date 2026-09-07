// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockTransaction } = vi.hoisted(() => ({
  mockTransaction: vi.fn(),
}));

vi.mock("../database/client.js", () => ({
  db: { transaction: mockTransaction },
}));

import { roleBindings } from "../authz/role-binding.schema.js";
import { organizationMemberships } from "./organization.schema.js";
import {
  deleteOrganizationMember,
  upsertOrganizationMemberRole,
} from "./members.store.js";

const ORG_ID = "org-1";
const USER_ID = "user-1";

describe("organization member persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates membership and replaces the org role inside one transaction", async () => {
    const writes: string[] = [];
    const transaction = {
      execute: vi.fn(async () => writes.push("lock")),
      insert: vi.fn((table: unknown) => {
        if (table === organizationMemberships) {
          return {
            values: vi.fn(() => ({
              onConflictDoNothing: vi.fn(async () => writes.push("membership")),
            })),
          };
        }
        return { values: vi.fn(async () => writes.push("role binding")) };
      }),
      delete: vi.fn(() => ({ where: vi.fn(async () => writes.push("old org binding")) })),
    };
    mockTransaction.mockImplementation(async (callback: (tx: typeof transaction) => unknown) =>
      callback(transaction),
    );

    await upsertOrganizationMemberRole({
      organizationId: ORG_ID,
      userId: USER_ID,
      roleId: "role-member",
      actorId: "owner-1",
    });

    expect(mockTransaction).toHaveBeenCalledOnce();
    expect(transaction.insert).toHaveBeenNthCalledWith(1, organizationMemberships);
    expect(transaction.delete).toHaveBeenCalledWith(roleBindings);
    expect(transaction.insert).toHaveBeenNthCalledWith(2, roleBindings);
    expect(transaction.execute).toHaveBeenCalledOnce();
    expect(writes).toEqual(["lock", "membership", "old org binding", "role binding"]);
  });

  it("deletes every organization binding before deleting membership in one transaction", async () => {
    const deletes: string[] = [];
    const transaction = {
      execute: vi.fn(async () => deletes.push("lock")),
      delete: vi.fn((table: unknown) => ({
        where: vi.fn(async () => deletes.push(table === roleBindings ? "bindings" : "membership")),
      })),
    };
    mockTransaction.mockImplementation(async (callback: (tx: typeof transaction) => unknown) =>
      callback(transaction),
    );

    await deleteOrganizationMember(ORG_ID, USER_ID);

    expect(mockTransaction).toHaveBeenCalledOnce();
    expect(transaction.delete).toHaveBeenNthCalledWith(1, roleBindings);
    expect(transaction.delete).toHaveBeenNthCalledWith(2, organizationMemberships);
    expect(transaction.execute).toHaveBeenCalledOnce();
    expect(deletes).toEqual(["lock", "bindings", "membership"]);
  });
});
