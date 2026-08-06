// SPDX-License-Identifier: AGPL-3.0-or-later

import type { McpAuthMode } from "../../instances/mcp-servers.store.js";

const MASK = "••••";

// Nested paths to the secret field, per authMode (shapes defined in
// instances/mcp-servers.store.ts): static nests the token under `auth`
// (both the bearer and header variants share `auth.token`); oauth carries
// two independent secrets — the admin-entered `staticClient.clientSecret`
// and the server-issued `dcrClient.client_secret` (DCR spec field name).
// Exported so export.service.ts's stripMcpSecrets can derive its deletions
// from this SAME list instead of hand-duplicating the secret paths (a
// future secret field added here and missed there would leak into a bundle).
export const MCP_SECRET_PATHS: Record<McpAuthMode, string[][]> = {
  static: [["auth", "token"]],
  oauth: [
    ["staticClient", "clientSecret"],
    ["dcrClient", "client_secret"],
  ],
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

/** Deep-copy of config with every secret field redacted to MASK+last4 (for API responses). */
export function maskMcpConfig(authMode: McpAuthMode, config: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(config);
  for (const path of MCP_SECRET_PATHS[authMode]) {
    const value = getPath(copy, path);
    if (value !== undefined && value !== null && value !== "") {
      setPath(copy, path, MASK + String(value).slice(-4));
    }
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
  return copy;
}
