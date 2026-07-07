// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { HOOK_EVENTS, HOOK_ACTION_TYPES } from "./hook-types.js";
import { getHookRegistry } from "./hook-registry.js";

export const hookActionConfigSchema = z.object({
  functionName: z.string().min(1, "functionName is required"),
});

export const createHookSchema = z.object({
  event: z.enum(HOOK_EVENTS),
  actionType: z.enum(HOOK_ACTION_TYPES).default("function"),
  actionConfig: hookActionConfigSchema,
  enabled: z.boolean().default(true),
  position: z.number().int().min(0).default(0),
  timeoutMs: z.number().int().min(1000).max(30_000).default(10_000),
});

export const updateHookSchema = createHookSchema.partial();

/** Error message when the function cannot back a hook, or null when valid. */
export function validateHookFunction(functionName: string): string | null {
  if (!getHookRegistry().has(functionName)) {
    return `Hook function "${functionName}" is not registered`;
  }
  return null;
}
