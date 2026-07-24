// SPDX-License-Identifier: AGPL-3.0-or-later

import type { McpAuthMode } from "../../../instances/mcp-servers.store.js";

export interface McpTestOptions {
  url: string;
  authMode: McpAuthMode;
  config: Record<string, unknown>;
}

export interface McpTestResult {
  ok: boolean;
  tools?: string[];
  requiresOAuth?: boolean;
  error?: string;
}

// ponytail: stub for Task 5 (controller) so it compiles ahead of Task 7,
// which replaces this body with a real MCP connect-and-list-tools call.
export async function testMcpConnection(_opts: McpTestOptions): Promise<McpTestResult> {
  return { ok: true };
}
