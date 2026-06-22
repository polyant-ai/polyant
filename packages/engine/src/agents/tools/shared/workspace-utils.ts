// SPDX-License-Identifier: AGPL-3.0-or-later

import { fileURLToPath } from "node:url";
import { resolve, dirname, basename, join, sep, isAbsolute } from "node:path";
import { mkdir, realpath } from "node:fs/promises";

const __sharedDir = dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = resolve(__sharedDir, "../../../..");

/**
 * Root directory for per-conversation sandboxes.
 * Layout: {OA_SANDBOX_ROOT}/{agentId}/conversations/{conversationId}/
 *
 * CONVENTION-EXCEPTION: dual env read during the sandbox rename deprecation
 * window. SANDBOX_ROOT is the new var; WORKSPACES_ROOT is kept as a deprecated
 * alias and removed next release. Default on-disk path value is unchanged.
 */
const sandboxRootEnv = process.env.SANDBOX_ROOT ?? process.env.WORKSPACES_ROOT;
export const OA_SANDBOX_ROOT = sandboxRootEnv
  ? resolve(sandboxRootEnv)
  : resolve(ENGINE_ROOT, "workspaces");

const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Sanitize a conversationId for safe use as a filesystem directory name.
 * ConversationIds may contain colons (e.g. "instance:web:user-xyz") and other
 * characters that are problematic on some filesystems. Replace anything
 * outside [a-zA-Z0-9._-] with "_".
 */
export function sanitizeConversationId(conversationId: string): string {
  if (!conversationId) {
    throw new Error("conversationId is required");
  }
  return conversationId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function validateAgentId(agentId: string): void {
  if (!AGENT_ID_RE.test(agentId)) {
    throw new Error(
      `Invalid agentId "${agentId}". Must match ${AGENT_ID_RE}.`,
    );
  }
}

/**
 * Absolute path of the sandbox directory for a given (instance, conversation).
 */
export function getConversationWorkspaceDir(
  agentId: string,
  conversationId: string,
): string {
  validateAgentId(agentId);
  const safeConv = sanitizeConversationId(conversationId);
  return resolve(OA_SANDBOX_ROOT, agentId, "conversations", safeConv);
}

/**
 * True if the path is relative (i.e. does not start with "/" or a drive letter).
 */
export function isRelativePath(p: string): boolean {
  return !isAbsolute(p);
}

/**
 * Assert that `resolvedPath` is contained within `workspaceDir`.
 * Allows equality (the workspace root itself) or strict containment.
 * Purely string-based — does NOT follow symlinks. Use `resolveWorkspacePath`
 * or `assertInsideConversationWorkspace` for symlink-safe validation.
 */
export function assertInsideWorkspace(
  resolvedPath: string,
  workspaceDir: string,
): void {
  if (resolvedPath === workspaceDir) return;
  if (!resolvedPath.startsWith(workspaceDir + sep)) {
    throw new Error(
      "Access denied: path escapes the conversation workspace sandbox.",
    );
  }
}

/**
 * Resolve the real (symlink-followed) path of the deepest existing ancestor,
 * then rejoin the missing segments. Used to check containment for paths that
 * don't exist yet (e.g. writeFile target) while still catching symlinks on
 * existing ancestors.
 *
 * If no ancestor exists (pathological case), returns the input unchanged.
 */
async function resolveRealpathOfExisting(p: string): Promise<string> {
  const missing: string[] = [];
  let cur = p;
  while (true) {
    try {
      const real = await realpath(cur);
      return missing.length > 0 ? join(real, ...missing) : real;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      const parent = dirname(cur);
      if (parent === cur) {
        // Reached filesystem root without finding an existing ancestor — return as-is
        return p;
      }
      missing.unshift(basename(cur));
      cur = parent;
    }
  }
}

/**
 * Resolve a relative path within the conversation workspace, rejecting any
 * attempt to escape the sandbox.
 *
 * Rejection cases:
 *  - Null bytes, empty string, absolute path passed as relative
 *  - Traversal via `../` that escapes the workspace (detected by path normalization)
 *  - Symlinks that resolve to a location outside the workspace (detected by `realpath`)
 *
 * Returns the normalized absolute path (NOT the realpath — for log/UX coherence).
 */
export async function resolveWorkspacePath(
  relativePath: string,
  agentId: string,
  conversationId: string,
): Promise<string> {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new Error("Relative path is required.");
  }
  if (relativePath.includes("\0")) {
    throw new Error("Path contains invalid characters (null byte).");
  }
  if (isAbsolute(relativePath)) {
    throw new Error(
      "Conversation workspace only accepts relative paths — an absolute path was provided.",
    );
  }

  const workspaceDir = getConversationWorkspaceDir(agentId, conversationId);
  // path.resolve() normalizes away "../" segments — first-line traversal defense.
  const normalized = resolve(workspaceDir, relativePath);
  assertInsideWorkspace(normalized, workspaceDir);

  // Symlink defense: compare real paths (follows symlinks on existing ancestors).
  // Use the same "walk up to existing ancestor" strategy for the workspace dir too,
  // so macOS symlinks (e.g. /Users → /System/Volumes/Data/Users) produce consistent
  // realpaths for both sides of the comparison even when the workspace doesn't
  // exist yet (first write into a new conversation).
  const realWorkspaceDir = await resolveRealpathOfExisting(workspaceDir);
  const realTarget = await resolveRealpathOfExisting(normalized);
  assertInsideWorkspace(realTarget, realWorkspaceDir);

  return normalized;
}

/**
 * Create the conversation workspace directory if it doesn't exist (mkdir -p).
 * Idempotent.
 */
export async function ensureWorkspaceDir(
  agentId: string,
  conversationId: string,
): Promise<string> {
  const dir = getConversationWorkspaceDir(agentId, conversationId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Assert that an ABSOLUTE path is contained within the conversation workspace.
 * Used to validate paths returned from tools like gitCloneRepo and then passed
 * back to readFile/listDirectory.
 *
 * Performs BOTH the string-based normalized containment check AND the
 * realpath-based check, so a symlink on the resolved path that escapes the
 * workspace is caught.
 */
export async function assertInsideConversationWorkspace(
  resolvedPath: string,
  agentId: string,
  conversationId: string,
): Promise<void> {
  const workspaceDir = getConversationWorkspaceDir(agentId, conversationId);

  // String-based check first (fast path, normalized paths)
  assertInsideWorkspace(resolvedPath, workspaceDir);

  // Realpath check (symlink defense). Use walk-up-to-existing-ancestor on both
  // sides so symlinked mount points (e.g. macOS /Users → /System/Volumes/Data/Users)
  // produce consistent realpaths for the comparison.
  const realWorkspaceDir = await resolveRealpathOfExisting(workspaceDir);
  const realTarget = await resolveRealpathOfExisting(resolvedPath);
  assertInsideWorkspace(realTarget, realWorkspaceDir);
}
