// SPDX-License-Identifier: AGPL-3.0-or-later

import { instanceHooks } from "../hooks/hooks.schema.js";
import type { HookActionConfig, HookActionType, HookEvent } from "../hooks/hook-types.js";
import type { ExportInstanceData } from "./export.schema.js";
import type { TxClient } from "./import.types.js";

export async function importHooks(
  tx: TxClient,
  instanceId: string,
  hooks: ExportInstanceData["hooks"],
): Promise<void> {
  for (const h of hooks) {
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
}
