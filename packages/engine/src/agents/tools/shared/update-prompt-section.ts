// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { chat } from "../../../ai-gateway/index.js";
import { getPromptSection, upsertPrompt } from "../../../instances/prompts.store.js";
import { resolveAgentId } from "../../../instances/resolve-agent-id.js";
import { registerTool, type ToolContext } from "../registry.js";
import { errMsg } from "../../../utils/error.js";
import { auditPreview } from "../../../audit/audit-logger.js";

interface PromptUpdaterConfig {
  toolName: string;
  description: string;
  sectionId: string;
  displayName: string;
  defaultContent: string;
  paramDescription: string;
  auditAction: string;
  buildSystemPrompt: () => string;
  buildUserPrompt: (instruction: string, currentContent: string) => string;
}

export function createPromptUpdaterTool(config: PromptUpdaterConfig): void {
  registerTool({
    name: config.toolName,
    description: config.description,
    category: "prompts",
    create: (ctx: ToolContext) => ({
      parameters: z.object({
        instruction: z.string().describe(config.paramDescription),
      }),
      execute: async ({ instruction }: { instruction: string }) => {
        try {
          const agentId = await resolveAgentId(ctx.agentId);
          if (!agentId) {
            return { updated: false, error: "Agent not found" };
          }

          const section = await getPromptSection(agentId, config.sectionId);
          const current = section?.content ?? config.defaultContent;

          const response = await chat(
            {
              tier: "fast",
              apiKeys: {
                openai: ctx.secrets?.openai_api_key,
                anthropic: ctx.secrets?.anthropic_api_key,
              },
              system: config.buildSystemPrompt(),
              messages: [
                {
                  role: "user",
                  content: config.buildUserPrompt(instruction, current),
                },
              ],
            },
            { agentId: ctx.agentId, callType: "service" },
          );

          const newContent = response.text.trim() + "\n";
          await upsertPrompt(agentId, config.sectionId, config.displayName, newContent);
          ctx.audit.log({
            action: config.auditAction,
            details: { instructionPreview: auditPreview(instruction) },
            success: true,
          });
          return { updated: true };
        } catch (err) {
          const message = errMsg(err);
          console.error(`${config.toolName} error: ${message}`);
          ctx.audit.log({
            action: config.auditAction,
            details: { instructionPreview: auditPreview(instruction) },
            success: false,
            error: message,
          });
          return { updated: false, error: message };
        }
      },
    }),
  });
}
