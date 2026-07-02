// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  getToolRegistry,
  fillMissingKeysWithNull,
  fillAndValidate,
  isSerializedTool,
  type ToolContext,
} from "../../agents/tools/registry.js";
import { createAuditLogger } from "../../audit/audit-logger.js";
import { renderArgsTemplate } from "../hook-template.js";
import type { HookActionExecutor } from "../hook-types.js";

/** Max serialized chars of a tool result kept in telemetry (UI display, not replay). */
export const MAX_HOOK_RESULT_CHARS = 4000;

/** JSON-stringify a tool result best-effort and truncate for telemetry. */
function serializeResult(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  let serialized: string;
  try {
    serialized = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  if (serialized === undefined) return undefined;
  return serialized.length > MAX_HOOK_RESULT_CHARS
    ? `${serialized.slice(0, MAX_HOOK_RESULT_CHARS)}… [truncated]`
    : serialized;
}

/**
 * `tool` action: execute a registered tool with statically-configured,
 * template-rendered args. Throws on misconfiguration (missing tool, meta-tool,
 * schema mismatch) — the runner catches, audits, and continues. Rendered args
 * and the (truncated) result are reported via `capture` for telemetry.
 */
export const toolActionExecutor: HookActionExecutor = {
  async execute(hook, payload, ctx, capture) {
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
    // Report the input BEFORE executing so it survives failures/timeouts.
    capture({ args: rendered });

    const toolCtx: ToolContext = {
      instanceId: ctx.instanceId,
      secrets: ctx.secrets,
      audit: createAuditLogger(toolName, ctx.instanceId, ctx.conversationId),
      conversationId: ctx.conversationId,
      apiKeys: ctx.apiKeys,
      provider: ctx.provider,
      state: ctx.state,
    };

    if (isSerializedTool(def)) {
      // Serialized tools carry a JSON Schema (no live Zod) — fill missing nullable
      // keys then validate against it (parity with the legacy safeParse branch).
      const r = fillAndValidate(def.inputSchema, rendered);
      if (!r.ok) {
        throw new Error(`args do not match tool "${toolName}" schema: ${r.error}`);
      }
      capture({ args: r.value as Record<string, unknown> });
      const result = await def.execute(r.value, toolCtx);
      capture({ result: serializeResult(result) });
      return;
    }

    const { parameters, execute } = def.create(toolCtx);
    const parsed = parameters.safeParse(fillMissingKeysWithNull(parameters, rendered));
    if (!parsed.success) {
      throw new Error(
        `args do not match tool "${toolName}" schema: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      );
    }
    capture({ args: parsed.data as Record<string, unknown> });
    const result = await execute(parsed.data);
    capture({ result: serializeResult(result) });
  },
};
