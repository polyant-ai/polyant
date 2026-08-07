// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import type { Instance, SkillState, ToolState } from "@/lib/api";
import { ToolsTab } from "./tools-tab";
import { McpServersTab } from "./mcp-servers-tab";

/**
 * What this agent can DO: the tools the engine ships, and the tools it reaches
 * through an MCP server.
 *
 * Two sections before. They answer the same question — one for capabilities that
 * live in the engine, one for capabilities that live somewhere else and arrive as
 * `mcp__<server>__*` — and "is that tool available?" should not depend on knowing
 * which side of that line it falls on.
 *
 * The MCP block keeps its own gate: `mcp-servers.controller.ts` enforces the
 * CHANNEL permission (an MCP server is a connection this agent holds credentials
 * for), so it fails on its own terms rather than borrowing the page's.
 */
export function ToolsSection({
  instance,
  tools,
  skills,
  onToolsUpdate,
  onSkillsUpdate,
}: {
  instance: Instance;
  tools: ToolState[];
  skills: SkillState[];
  onToolsUpdate: (tools: ToolState[]) => void;
  onSkillsUpdate: (skills: SkillState[]) => void;
}) {
  return (
    <div className="space-y-10">
      <ToolsTab
        slug={instance.slug}
        tools={tools}
        skills={skills}
        memoryEnabled={instance.memoryEnabled}
        knowledgeEnabled={instance.knowledgeEnabled}
        onToolsUpdate={onToolsUpdate}
        onSkillsUpdate={onSkillsUpdate}
      />

      <div className="border-t pt-8">
        <McpServersTab slug={instance.slug} />
      </div>
    </div>
  );
}
