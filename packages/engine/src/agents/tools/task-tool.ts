// SPDX-License-Identifier: AGPL-3.0-or-later

import { tool, type Tool } from "ai";
import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";
import { chat } from "../../ai-gateway/index.js";
import type { ChatRequest } from "../../ai-gateway/types.js";
import { createAuditLogger, auditPreview } from "../../audit/audit-logger.js";
import { errMsg } from "../../utils/error.js";
import { asInstanceSlug, type InstanceSlug } from "../../instances/identifiers.js";

const SPAWN_TASK_DESCRIPTION =
  "Delegate a specific task to an isolated sub-agent with separate context. " +
  "The sub-agent runs the task without knowledge of the current conversation and returns the result. " +
  "Useful for deep research, complex analysis, or tasks that require multiple autonomous steps.";

// Catalog entry only — spawnTask is a meta-tool: the supervisor builds the real
// tool via `createTaskTool` (it needs the sibling tool set + apiKeys, which the
// generic buildTool(ctx) path does not have). `execute` is never invoked through
// the registry; buildTools skips meta-tools.
export default defineTool({
  name: "spawnTask",
  description: SPAWN_TASK_DESCRIPTION,
  category: "agent",
  metaTool: true,
  parameters: z.object({
    task: z.string().describe("Detailed description of the task to perform"),
    label: z.string().nullable().describe("Short label to identify the task in logs. Pass null if not needed."),
  }),
  execute: async () => {
    throw new Error("Meta-tool: built separately by supervisor");
  },
});

/**
 * Factory: creates a spawnTask tool that delegates work to an isolated sub-agent.
 * Defensive filter: spawnTask is stripped from the sub-agent's tool set so a
 * sub-agent can never re-invoke itself (depth max = 0 from the sub's POV).
 */
export function createTaskTool(subAgentTools: Record<string, Tool>, apiKeys?: ChatRequest["apiKeys"], instanceId?: InstanceSlug, conversationId?: string) {
  const audit = createAuditLogger("spawnTask", instanceId ?? asInstanceSlug("unknown"), conversationId);
  const { spawnTask: _drop, ...isolatedTools } = subAgentTools;
  void _drop;
  return tool({
    description:
      "Delegate a specific task to an isolated sub-agent with separate context. " +
      "The sub-agent runs the task without knowledge of the current conversation and returns the result. " +
      "Useful for deep research, complex analysis, or tasks that require multiple autonomous steps.",
    inputSchema: z.object({
      task: z.string().describe("Detailed description of the task to perform"),
      label: z.string().nullable().optional().describe("Short label to identify the task in logs. Pass null if not needed."),
    }),
    execute: async ({ task, label }) => {
      const taskLabel = label ?? task.slice(0, 50);

      try {
        const response = await chat(
          {
            tier: "standard",
            apiKeys,
            system: `You are a specialized agent. Execute the following task precisely and completely.

Task: ${task}

Rules:
- Use the available tools when necessary
- Reply in the same language as the task
- Be concise yet complete in the result
- Do not ask for clarification: act on the information provided
- You cannot delegate further: the spawnTask tool is NOT available in this context`,
            messages: [{ role: "user", content: task }],
            tools: isolatedTools,
            maxSteps: 10,
          },
          { instanceId, conversationId, callType: "service" },
        );

        const toolsUsed = response.steps.flatMap((s) => s.toolCalls.map((tc) => tc.toolName));
        audit.log({
          action: "agent.spawn",
          details: { label: taskLabel, taskPreview: auditPreview(task), toolsUsed },
          success: true,
          durationMs: response.durationMs,
        });

        return {
          success: true,
          result: response.text,
          toolsUsed,
        };
      } catch (err) {
        const message = errMsg(err);
        audit.log({
          action: "agent.spawn",
          details: { label: taskLabel, taskPreview: auditPreview(task) },
          success: false,
          error: message,
        });
        return {
          success: false,
          result: null,
          error: message,
        };
      }
    },
  });
}
