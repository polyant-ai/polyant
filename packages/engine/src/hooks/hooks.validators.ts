// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import { HOOK_EVENTS, HOOK_ACTION_TYPES } from "./hook-types.js";
import { getToolRegistry } from "../agents/tools/registry.js";

export const hookActionConfigSchema = z.object({
  toolName: z.string().min(1, "toolName is required"),
  args: z.record(z.string(), z.unknown()).default({}),
});

export const createHookSchema = z.object({
  event: z.enum(HOOK_EVENTS),
  actionType: z.enum(HOOK_ACTION_TYPES).default("tool"),
  actionConfig: hookActionConfigSchema,
  enabled: z.boolean().default(true),
  position: z.number().int().min(0).default(0),
  timeoutMs: z.number().int().min(1000).max(30_000).default(10_000),
});

export const updateHookSchema = createHookSchema.partial();

/** Error message when the tool cannot back a hook, or null when valid. */
export function validateHookTool(toolName: string): string | null {
  const def = getToolRegistry().get(toolName);
  if (!def) return `Tool "${toolName}" is not registered`;
  if (def.metaTool) return `Tool "${toolName}" is a meta-tool and cannot be used in hooks`;
  return null;
}
