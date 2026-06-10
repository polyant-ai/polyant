// SPDX-License-Identifier: AGPL-3.0-or-later

import { getToolRegistry, fillMissingKeysWithNull } from "../../agents/tools/registry.js";
import { createAuditLogger } from "../../audit/audit-logger.js";
import { renderArgsTemplate } from "../hook-template.js";
import type { HookActionExecutor } from "../hook-types.js";

/**
 * `tool` action: execute a registered tool with statically-configured,
 * template-rendered args. Throws on misconfiguration (missing tool, meta-tool,
 * schema mismatch) — the runner catches, audits, and continues.
 */
export const toolActionExecutor: HookActionExecutor = {
  async execute(hook, payload, ctx) {
    const { toolName, args } = hook.actionConfig;
    const def = getToolRegistry().get(toolName);
    if (!def) throw new Error(`tool "${toolName}" is not registered`);
    if (def.metaTool) throw new Error(`tool "${toolName}" is a meta-tool and cannot be used in hooks`);

    const { args: rendered, unresolved } = renderArgsTemplate(args ?? {}, payload);
    if (unresolved.length > 0) {
      console.warn(
        `[hooks] ${hook.event} "${toolName}": unresolved placeholder(s) ${unresolved.join(", ")} — rendered as empty string`,
      );
    }

    const { parameters, execute } = def.create({
      instanceId: ctx.instanceId,
      secrets: ctx.secrets,
      audit: createAuditLogger(toolName, ctx.instanceId, ctx.conversationId),
      conversationId: ctx.conversationId,
      apiKeys: ctx.apiKeys,
      provider: ctx.provider,
      state: ctx.state,
    });

    const parsed = parameters.safeParse(fillMissingKeysWithNull(parameters, rendered));
    if (!parsed.success) {
      throw new Error(
        `args do not match tool "${toolName}" schema: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      );
    }
    await execute(parsed.data);
  },
};
