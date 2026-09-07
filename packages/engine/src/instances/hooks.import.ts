// SPDX-License-Identifier: AGPL-3.0-or-later

import { instanceHooks } from "../hooks/hooks.schema.js";
import { HOOK_EVENTS, HOOK_ACTION_TYPES, type HookEvent, type HookActionType, type HookActionConfig } from "../hooks/hook-types.js";
import { validateHookFunction } from "../hooks/hooks.validators.js";
import type { ExportInstanceData } from "./export.schema.js";
import type { ImportWarning, TxClient } from "./import.types.js";

type BundledHook = ExportInstanceData["hooks"][number];

// export/import round-trips event/actionType as bare strings (a bundle must
// survive a future/foreign version writing an event this build doesn't know),
// so an unrecognized value is NOT rejected by the bundle schema. There is no
// DB CHECK on `event`/`action_type` either (plain varchar(32)) — validate here
// or a bogus row persists silently and only surfaces at the first conversation
// turn, when hook-runner.ts looks up a registry entry that was never checked
// to exist. Skip the hook entirely, mirroring the per-item degradation used
// for MCP servers/channels/skills.
function hookInvalidWarning(hook: BundledHook): ImportWarning | null {
  if (!HOOK_EVENTS.includes(hook.event as HookEvent)) {
    return { type: "hook_invalid", message: `Hook on unknown event "${hook.event}" — skipped` };
  }
  if (!HOOK_ACTION_TYPES.includes(hook.actionType as HookActionType)) {
    return { type: "hook_invalid", message: `Hook with unknown actionType "${hook.actionType}" — skipped` };
  }
  const functionName = hook.actionConfig?.functionName;
  if (typeof functionName !== "string" || functionName.length === 0) {
    return { type: "hook_invalid", message: "Hook is missing actionConfig.functionName — skipped" };
  }
  const registryError = validateHookFunction(functionName);
  if (registryError) {
    return { type: "hook_invalid", message: `${registryError} — skipped` };
  }
  return null;
}

export async function importHooks(
  tx: TxClient,
  instanceId: string,
  hooks: ExportInstanceData["hooks"],
): Promise<ImportWarning[]> {
  const warnings: ImportWarning[] = [];

  for (const h of hooks) {
    const invalid = hookInvalidWarning(h);
    if (invalid) {
      warnings.push(invalid);
      continue;
    }

    await tx.insert(instanceHooks).values({
      instanceId,
      event: h.event as HookEvent,
      actionType: h.actionType as HookActionType,
      actionConfig: h.actionConfig as unknown as HookActionConfig,
      enabled: h.enabled,
      position: h.position,
      timeoutMs: h.timeoutMs,
    });
  }

  return warnings;
}
