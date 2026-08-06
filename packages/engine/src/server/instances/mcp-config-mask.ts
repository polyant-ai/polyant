// SPDX-License-Identifier: AGPL-3.0-or-later

import type { McpAuthMode } from "../../instances/mcp-servers.store.js";

const MASK = "••••";

// Nested paths to the secret field, per authMode (shapes defined in
// instances/mcp-servers.store.ts): static nests the token under `auth`
// (both the bearer and header variants share `auth.token`); oauth's LEAF
// secret is the admin-entered `staticClient.clientSecret` — the server-issued
// DCR registration is handled as a whole subtree instead (see
// MCP_SECRET_SUBTREES below), because its credential-bearing keys are decided
// by the authorization server, not by us.
// Exported so export.service.ts's stripMcpSecrets can derive its deletions
// from this SAME list instead of hand-duplicating the secret paths (a
// future secret field added here and missed there would leak into a bundle).
export const MCP_SECRET_PATHS: Record<McpAuthMode, string[][]> = {
  // Nothing to mask, and nothing to strip from an export bundle: a `none` server
  // holds no credential by construction (its schema is `.strict()`).
  none: [],
  static: [["auth", "token"]],
  oauth: [["staticClient", "clientSecret"]],
};

/**
 * Whole SUBTREES that are credential-bearing and must never leave the process
 * in cleartext, regardless of which keys they happen to carry.
 *
 * `dcrClient` is the DCR (RFC 7591) registration response, persisted verbatim
 * by `saveClientInformation` (mcp-oauth-provider.ts). Besides `client_secret`
 * it typically carries `registration_access_token` — an RFC 7592 bearer that
 * can read, rotate or DELETE the client registration — plus
 * `registration_client_uri`. A per-leaf list can therefore never be complete
 * (the authorization server decides the shape), so the whole subtree is
 * redacted on the response path and DELETED on the export path.
 *
 * Exported so export.service.ts's `stripMcpSecrets` derives its deletions from
 * this SAME list instead of hand-duplicating them.
 */
export const MCP_SECRET_SUBTREES: Record<McpAuthMode, string[][]> = {
  none: [],
  static: [],
  oauth: [["dcrClient"]],
};

function getPath(obj: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** No-op if any ancestor in `path` is missing/not an object — never fabricates structure. */
function setPath(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const next = cur[path[i]];
    if (typeof next !== "object" || next === null) return;
    cur = next as Record<string, unknown>;
  }
  const lastKey = path[path.length - 1];
  if (!(lastKey in cur)) return;
  cur[lastKey] = value;
}

function maskValue(value: unknown): unknown {
  return MASK + String(value).slice(-4);
}

/** Recursively redact every primitive leaf inside a credential-bearing subtree. */
function maskDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskDeep);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, maskDeep(v)]));
  }
  if (value === undefined || value === null || value === "") return value;
  return maskValue(value);
}

/** True when any primitive leaf inside `value` is an already-masked string. */
function containsMasked(value: unknown): boolean {
  if (typeof value === "string") return value.startsWith(MASK);
  if (Array.isArray(value)) return value.some(containsMasked);
  if (typeof value === "object" && value !== null) return Object.values(value as Record<string, unknown>).some(containsMasked);
  return false;
}

/**
 * Like `setPath` but assigns the leaf even when absent (ancestors must still
 * exist). Used when restoring a whole secret subtree the client omitted.
 */
function setPathForce(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const next = cur[path[i]];
    if (typeof next !== "object" || next === null) return;
    cur = next as Record<string, unknown>;
  }
  cur[path[path.length - 1]] = value;
}

/** Deep-copy of config with every secret field redacted to MASK+last4 (for API responses). */
export function maskMcpConfig(authMode: McpAuthMode, config: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(config);
  for (const path of MCP_SECRET_PATHS[authMode]) {
    const value = getPath(copy, path);
    if (value !== undefined && value !== null && value !== "") {
      setPath(copy, path, maskValue(value));
    }
  }
  for (const path of MCP_SECRET_SUBTREES[authMode]) {
    const value = getPath(copy, path);
    if (value !== undefined && value !== null) setPath(copy, path, maskDeep(value));
  }
  return copy;
}

/**
 * Deep-copy of `incoming` where any secret field that is missing OR a
 * MASK-prefixed string is restored from `existing`. Used on write so a
 * client re-submitting masked values (echoed back from `maskMcpConfig`)
 * doesn't overwrite the real secret with the mask itself.
 */
export function mergeMaskedMcpSecrets(
  authMode: McpAuthMode,
  incoming: Record<string, unknown>,
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const copy = structuredClone(incoming);
  for (const path of MCP_SECRET_PATHS[authMode]) {
    const incomingValue = getPath(copy, path);
    const isMasked = incomingValue === undefined || (typeof incomingValue === "string" && incomingValue.startsWith(MASK));
    if (!isMasked) continue;
    const existingValue = existing ? getPath(existing, path) : undefined;
    if (existingValue !== undefined) setPath(copy, path, existingValue);
  }
  // Subtrees are restored WHOLESALE: the response path redacts every leaf, so a
  // client echoing one back would otherwise persist a tree of masks.
  for (const path of MCP_SECRET_SUBTREES[authMode]) {
    const incomingValue = getPath(copy, path);
    if (incomingValue !== undefined && !containsMasked(incomingValue)) continue;
    const existingValue = existing ? getPath(existing, path) : undefined;
    if (existingValue !== undefined) setPathForce(copy, path, existingValue);
  }
  return copy;
}
