// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * RBAC permission taxonomy (`resource:action`) and the OSS system-role catalog
 * with its full permission matrix (design §3.2 + §4.2).
 *
 * This module is the single source of truth shared by the migration seed and
 * the tests, so the matrix is never duplicated as magic strings. The migration
 * seeds the exact rows the `SYSTEM_ROLE_PERMISSIONS` map describes.
 */

export const Permission = {
  AGENT_READ: "agent:read",
  AGENT_WRITE: "agent:write",
  AGENT_DELETE: "agent:delete",
  SECRET_READ: "agent.secret:read",
  SECRET_WRITE: "agent.secret:write",
  CHANNEL_READ: "agent.channel:read",
  CHANNEL_WRITE: "agent.channel:write",
  SKILL_INSTANCE_READ: "agent.skill:read",
  SKILL_INSTANCE_WRITE: "agent.skill:write",
  TOOL_READ: "agent.tool:read",
  TOOL_WRITE: "agent.tool:write",
  PROMPT_READ: "agent.prompt:read",
  PROMPT_WRITE: "agent.prompt:write",
  ROOM_READ: "agent.room:read",
  ROOM_WRITE: "agent.room:write",
  TASK_READ: "agent.task:read",
  TASK_WRITE: "agent.task:write",
  KNOWLEDGE_READ: "agent.knowledge:read",
  KNOWLEDGE_WRITE: "agent.knowledge:write",
  GOVERNANCE_READ: "agent.governance:read",
  GOVERNANCE_WRITE: "agent.governance:write",
  EXPORT_READ: "agent.export:read",
  CONVERSATION_READ: "conversation:read",
  CONVERSATION_DELETE: "conversation:delete",
  MEMORY_READ: "memory:read",
  MEMORY_WRITE: "memory:write",
  ANALYTICS_READ: "analytics:read",
  SKILL_CATALOG_READ: "skill.catalog:read",
  SKILL_CATALOG_WRITE: "skill.catalog:write",
  ORG_READ: "org:read",
  ORG_WRITE: "org:write",
  MEMBER_MANAGE: "org.member:manage",
  AUDIT_LOG_READ: "audit_log:read",
} as const;

export type PermissionKey = (typeof Permission)[keyof typeof Permission];

export const SYSTEM_ROLE_KEYS = ["owner", "admin", "member", "viewer"] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

export interface SystemRoleDefinition {
  readonly key: SystemRoleKey;
  readonly name: string;
  readonly level: number;
}

export const SYSTEM_ROLES: readonly SystemRoleDefinition[] = [
  { key: "owner", name: "Owner", level: 40 },
  { key: "admin", name: "Admin", level: 30 },
  { key: "member", name: "Member", level: 20 },
  { key: "viewer", name: "Viewer", level: 10 },
] as const;

/** All read-only permissions a Viewer holds (secrets excluded by design). */
const VIEWER_PERMISSIONS: readonly PermissionKey[] = [
  Permission.AGENT_READ,
  Permission.CHANNEL_READ,
  Permission.SKILL_INSTANCE_READ,
  Permission.TOOL_READ,
  Permission.PROMPT_READ,
  Permission.ROOM_READ,
  Permission.TASK_READ,
  Permission.KNOWLEDGE_READ,
  Permission.GOVERNANCE_READ,
  Permission.CONVERSATION_READ,
  Permission.MEMORY_READ,
  Permission.ANALYTICS_READ,
  Permission.SKILL_CATALOG_READ,
  Permission.ORG_READ,
];

/** Member adds write on the assistant's behaviour (not secrets/channels-creds). */
const MEMBER_PERMISSIONS: readonly PermissionKey[] = [
  ...VIEWER_PERMISSIONS,
  Permission.AGENT_WRITE,
  Permission.CHANNEL_WRITE,
  Permission.SKILL_INSTANCE_WRITE,
  Permission.TOOL_WRITE,
  Permission.PROMPT_WRITE,
  Permission.ROOM_WRITE,
  Permission.TASK_WRITE,
  Permission.KNOWLEDGE_WRITE,
  Permission.EXPORT_READ,
  Permission.MEMORY_WRITE,
];

/** Admin adds credentials, deletes, governance writes, catalog and members. */
const ADMIN_PERMISSIONS: readonly PermissionKey[] = [
  ...MEMBER_PERMISSIONS,
  Permission.AGENT_DELETE,
  Permission.SECRET_READ,
  Permission.SECRET_WRITE,
  Permission.GOVERNANCE_WRITE,
  Permission.CONVERSATION_DELETE,
  Permission.SKILL_CATALOG_WRITE,
  Permission.MEMBER_MANAGE,
  Permission.AUDIT_LOG_READ,
];

/** Owner adds org:write (the only one who can edit org settings / delete org). */
const OWNER_PERMISSIONS: readonly PermissionKey[] = [
  ...ADMIN_PERMISSIONS,
  Permission.ORG_WRITE,
];

export const SYSTEM_ROLE_PERMISSIONS: Readonly<
  Record<SystemRoleKey, readonly PermissionKey[]>
> = {
  owner: OWNER_PERMISSIONS,
  admin: ADMIN_PERMISSIONS,
  member: MEMBER_PERMISSIONS,
  viewer: VIEWER_PERMISSIONS,
};
