// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, rmSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { sanitizeConversationId } from "../agents/tools/shared/workspace-utils.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

// CONVENTION-EXCEPTION: dual env read during the sandbox rename deprecation
// window. SANDBOX_ROOT is the new var; WORKSPACES_ROOT is kept as a deprecated
// alias and removed next release. Default on-disk path value is unchanged.
const sandboxRootEnv = process.env.SANDBOX_ROOT ?? process.env.WORKSPACES_ROOT;
const SANDBOX_ROOT = sandboxRootEnv
  ? resolve(sandboxRootEnv)
  : resolve(__dirname, "../../workspaces");

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const INSTANCE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function validateInstanceId(instanceId: string): void {
  if (!INSTANCE_ID_RE.test(instanceId)) {
    throw new Error(
      `Invalid instanceId "${instanceId}". Must match ${INSTANCE_ID_RE} (lowercase alphanumeric and hyphens, starting with alphanumeric).`,
    );
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkspacePaths {
  root: string;
  conversationsDir: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get workspace paths for an instance.
 * - `conversationsDir` is the parent of per-conversation sandboxed workspaces
 *   used by the readFile / writeFile / gitCloneRepo tools.
 * All agent configuration — including knowledge documents — is stored in
 * PostgreSQL.
 */
export function getWorkspacePaths(instanceId: string): WorkspacePaths {
  validateInstanceId(instanceId);
  const root = resolve(SANDBOX_ROOT, instanceId);
  return {
    root,
    conversationsDir: resolve(root, "conversations"),
  };
}

/**
 * Get the absolute path of a per-conversation sandboxed workspace.
 * The conversationId is sanitized for filesystem safety.
 */
export function getConversationWorkspacePath(
  instanceId: string,
  conversationId: string,
): string {
  validateInstanceId(instanceId);
  return resolve(
    getWorkspacePaths(instanceId).conversationsDir,
    sanitizeConversationId(conversationId),
  );
}

/** Delete an instance workspace (knowledge files + all conversation workspaces). */
export function deleteWorkspace(instanceId: string): void {
  validateInstanceId(instanceId);
  const paths = getWorkspacePaths(instanceId);
  if (existsSync(paths.root)) {
    rmSync(paths.root, { recursive: true, force: true });
  }
}

/** Delete the sandboxed workspace for a specific conversation. */
export function deleteConversationWorkspace(
  instanceId: string,
  conversationId: string,
): void {
  const dir = getConversationWorkspacePath(instanceId, conversationId);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
