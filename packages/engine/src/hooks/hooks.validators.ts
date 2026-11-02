// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { HOOK_EVENTS, HOOK_ACTION_TYPES } from "./hook-types.js";
import { getHookRegistry } from "./hook-registry.js";

export const hookActionConfigSchema = z.object({
  functionName: z.string().min(1, "functionName is required"),
});

const hookFields = {
  event: z.enum(HOOK_EVENTS),
  actionType: z.enum(HOOK_ACTION_TYPES),
  actionConfig: hookActionConfigSchema,
  enabled: z.boolean(),
  position: z.number().int().min(0),
  timeoutMs: z.number().int().min(1000).max(30_000),
};

export const createHookSchema = z.object({
  ...hookFields,
  actionType: hookFields.actionType.default("function"),
  enabled: hookFields.enabled.default(true),
  position: hookFields.position.default(0),
  timeoutMs: hookFields.timeoutMs.default(10_000),
});

/**
 * Built from the fields without their defaults: in Zod 4 an optional key with a
 * default takes the default when it is missing, so `createHookSchema.partial()`
 * turned a PATCH of `{ enabled }` into one that also reset the position and
 * the timeout.
 */
export const updateHookSchema = z.object(hookFields).partial();

/** Error message when the function cannot back a hook, or null when valid. */
export function validateHookFunction(functionName: string): string | null {
  if (!getHookRegistry().has(functionName)) {
    return `Hook function "${functionName}" is not registered`;
  }
  return null;
}
