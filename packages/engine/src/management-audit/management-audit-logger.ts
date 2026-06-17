// SPDX-License-Identifier: AGPL-3.0-or-later

import { type ManagementAuditStore, managementAuditStore } from "./management-audit.store.js";

/**
 * The destructive management mutations in OSS scope (RBAC Stream 7).
 * `member.remove` has no OSS endpoint yet (later RBAC stream) — the constant is
 * defined up front so the write path can wire it without re-touching this enum.
 */
export const ManagementAuditAction = {
  AgentCreate: "agent.create",
  AgentDelete: "agent.delete",
  SecretWrite: "secret.write",
  SecretDelete: "secret.delete",
  MemberRemove: "member.remove",
} as const;

export type ManagementAuditActionValue =
  (typeof ManagementAuditAction)[keyof typeof ManagementAuditAction];

/** The authenticated identity behind a mutation (may be absent at the edge). */
export interface ManagementAuditActor {
  userId?: string;
  email?: string;
}

export interface ManagementAuditInput {
  action: ManagementAuditActionValue;
  actor: ManagementAuditActor | undefined;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
}

/** Caller-facing API for the OSS management write-audit log. */
export interface ManagementAuditLogger {
  log(input: ManagementAuditInput): void;
}

/**
 * Create a logger bound to a store. Records one row per destructive mutation,
 * normalizing an absent actor to explicit `null`s (gateway mode / edge).
 */
export function createManagementAuditLogger(
  store: ManagementAuditStore = managementAuditStore,
): ManagementAuditLogger {
  return {
    log({ action, actor, targetType, targetId, metadata }) {
      store.record({
        action,
        actorUserId: actor?.userId ?? null,
        actorEmail: actor?.email ?? null,
        targetType,
        targetId,
        metadata: metadata ?? {},
      });
    },
  };
}
