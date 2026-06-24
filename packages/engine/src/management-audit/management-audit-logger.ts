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

/** The kinds of target a destructive management mutation can act on. */
export const ManagementAuditTarget = {
  Agent: "agent",
  Secret: "secret",
  Member: "member",
} as const;

export type ManagementAuditTargetValue =
  (typeof ManagementAuditTarget)[keyof typeof ManagementAuditTarget];

/** The authenticated identity behind a mutation (may be absent at the edge). */
export interface ManagementAuditActor {
  userId?: string;
  email?: string;
}

/** A minimal authenticated-identity shape (subset of AuthenticatedUser). */
interface AuditableUser {
  userId: string;
  email: string;
}

/**
 * Map an authenticated user to the audit actor shape. Returns undefined when
 * there is no identity (gateway mode / unauthenticated edge), which the logger
 * normalizes to explicit nulls.
 */
export function toManagementAuditActor(
  user: AuditableUser | undefined,
): ManagementAuditActor | undefined {
  return user ? { userId: user.userId, email: user.email } : undefined;
}

export interface ManagementAuditInput {
  action: ManagementAuditActionValue;
  actor: ManagementAuditActor | undefined;
  targetType: ManagementAuditTargetValue;
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
