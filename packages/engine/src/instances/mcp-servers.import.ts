// SPDX-License-Identifier: AGPL-3.0-or-later

import { instanceMcpServers } from "./mcp-servers.schema.js";
import { mcpServerConfigSchema, MCP_AUTH_MODES, type McpAuthMode } from "./mcp-servers.store.js";
import { assertSafeMcpUrl } from "../agents/tools/mcp/mcp-url-guard.js";
import { errMsg } from "../utils/error.js";
import { encrypt } from "../crypto/index.js";
import type { ExportInstanceData } from "./export.schema.js";
import type { ImportWarning, TxClient } from "./import.types.js";

type BundledMcpServer = ExportInstanceData["mcpServers"][number];

/** The only non-secret key shared by every MCP auth mode. */
function pickMcpAllowList(config: Record<string, unknown>): Record<string, unknown> {
  const allowList = config.allowList;
  if (!Array.isArray(allowList)) return {};
  const entries = allowList.filter((t): t is string => typeof t === "string");
  return entries.length > 0 ? { allowList: entries } : {};
}

/**
 * Validated + STRIPPED config when the (already-secret-stripped) bundle config
 * satisfies its authMode's schema — i.e. the server needs no secret to run;
 * null otherwise.
 *
 * Returning the parsed output (rather than a boolean) matters: the schema is
 * what drops unknown keys, exactly like `setMcpServer` does on the API write
 * path. Persisting the bundle's raw config instead would let a crafted bundle
 * seed arbitrary keys into the encrypted config — e.g. a fabricated
 * `dcrClient`/`authServerInfo` steering the OAuth flow at the next connect.
 */
function validateMcpServerConfig(authMode: McpAuthMode, config: Record<string, unknown>): Record<string, unknown> | null {
  try {
    return mcpServerConfigSchema(authMode, config) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// exportMcpServerSchema.authMode is z.string() (export must round-trip
// whatever a future/foreign version writes), so an unknown value (e.g.
// "oidc", or garbage) is NOT rejected by the bundle schema. Guard it here:
// mcpServerConfigSchema's last branch is the all-optional oauth schema, so a
// bogus mode would otherwise validate there and insert an ENABLED row the
// runtime does not recognize (there is no DB CHECK on auth_mode). Skip the
// server entirely rather than persist garbage — mirrors the per-item
// degradation used for channels/skills/tools.
function mcpAuthModeWarning(server: BundledMcpServer): ImportWarning | null {
  const authMode = server.authMode as McpAuthMode;
  if (MCP_AUTH_MODES.includes(authMode)) return null;
  return {
    type: "mcp_server_invalid",
    message: `MCP server "${server.slug}" has unknown authMode "${server.authMode}" — skipped`,
  };
}

// SSRF guard: the PUT/POST controller path validates every admin-entered URL
// (mcp-servers.controller.ts), so an import must too — otherwise a bundle
// carrying `authMode:"none"` and a link-local URL (e.g. the cloud metadata
// endpoint) lands ENABLED and every subsequent turn connects to it. Degrade
// per-item, like the unknown-authMode branch above.
function mcpUrlWarning(server: BundledMcpServer): ImportWarning | null {
  try {
    assertSafeMcpUrl(server.url);
    return null;
  } catch (err) {
    return {
      type: "mcp_server_invalid",
      message: `MCP server "${server.slug}" has an unusable URL (${errMsg(err)}) — skipped`,
    };
  }
}

async function importOneMcpServer(
  tx: TxClient,
  instanceId: string,
  server: BundledMcpServer,
): Promise<ImportWarning | null> {
  const invalid = mcpAuthModeWarning(server) ?? mcpUrlWarning(server);
  if (invalid) return invalid;

  // A server can be safely (re)enabled on import ONLY if its stripped config
  // alone satisfies the auth mode's validation schema — i.e. it needs no
  // secret. A static server fails this (the exporter stripped auth.token),
  // so it stays disabled until the token is reconfigured; an oauth server
  // with no required secret field passes and re-enables as-is.
  const authMode = server.authMode as McpAuthMode;
  const validated = validateMcpServerConfig(authMode, server.config ?? {});
  const canEnable = validated !== null;
  const enabled = server.enabled && canEnable;
  // Never persist the bundle's config verbatim. When the schema accepted it,
  // persist ITS output (unknown keys dropped, like setMcpServer). When it
  // didn't (a stripped secret), keep only `allowList` — the one non-secret
  // key every mode shares — so the admin just re-enters the credential.
  const config = validated ?? pickMcpAllowList(server.config ?? {});

  await tx
    .insert(instanceMcpServers)
    .values({
      instanceId,
      slug: server.slug,
      name: server.name,
      url: server.url,
      authMode: server.authMode,
      enabled,
      // Encrypted at rest like any MCP server config.
      config: encrypt(JSON.stringify(config)),
    })
    .onConflictDoNothing();

  if (server.enabled && !canEnable) {
    return {
      type: "mcp_server_credentials",
      message: `MCP server "${server.slug}" imported disabled — configure credentials to enable`,
    };
  }
  return null;
}

// Exported for direct unit testing (mirrors stripSensitiveKeys/exportMcpServers
// in export.service.ts — the store-level insert is simple enough to test with
// a fake `tx`, without mocking the whole database client).
export async function importMcpServers(
  tx: TxClient,
  instanceId: string,
  servers: ExportInstanceData["mcpServers"],
): Promise<ImportWarning[]> {
  const warnings: ImportWarning[] = [];

  for (const server of servers) {
    const warning = await importOneMcpServer(tx, instanceId, server);
    if (warning) warnings.push(warning);
  }

  return warnings;
}
