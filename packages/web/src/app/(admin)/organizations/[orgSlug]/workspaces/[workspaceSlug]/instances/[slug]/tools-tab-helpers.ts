// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RequiredSecretSpec, ToolPluginInfo, ToolState } from "@/lib/api";
import { PROVIDER_CREDENTIAL_KEYS } from "@/lib/provider-secrets";

/**
 * Pure display helpers for the Tools section; none of this needs component
 * state or hooks.
 */

/**
 * Prefixes that look like a plugin namespace and are not one: the engine's own
 * virtual tool families, `agent:<slug>` (delegation) and `mcp:<server>:<tool>`.
 * Mirrors the engine's `pluginNamespaceOf` in `agents/tools/registry.ts`; web
 * and engine share the wire contract, never runtime code.
 */
const VIRTUAL_TOOL_NAMESPACES = new Set(["agent", "mcp"]);

/** `"ns:tool"` → `"ns"`; `null` for a built-in tool and for the virtual families. */
export function pluginNamespaceOf(name: string): string | null {
  const i = name.indexOf(":");
  if (i === -1) return null;
  const namespace = name.slice(0, i);
  return VIRTUAL_TOOL_NAMESPACES.has(namespace) ? null : namespace;
}

/** The name a row shows: a plugin tool without its namespace, which the Origin column already says. */
export function toolDisplayName(name: string): string {
  return pluginNamespaceOf(name) === null ? name : name.slice(name.indexOf(":") + 1);
}

/**
 * How a plugin is named: its manifest's `displayName`, else its namespace as a
 * reader writes it. The fallback keeps plugins whose manifest predates the field
 * readable without asking their authors for anything.
 */
export function pluginName(namespace: string, plugins: readonly ToolPluginInfo[]): string {
  return plugins.find((p) => p.namespace === namespace)?.displayName ?? pluginLabel(namespace);
}

/** A plugin's own sentence about itself, when its manifest has one. */
export function pluginDescription(namespace: string, plugins: readonly ToolPluginInfo[]): string | null {
  return plugins.find((p) => p.namespace === namespace)?.description ?? null;
}

/** A plugin namespace as a reader writes it. */
export function pluginLabel(namespace: string): string {
  return namespace
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function categoryLabel(cat: string): string {
  return cat.charAt(0).toUpperCase() + cat.slice(1);
}

/**
 * The first line of a tool description. Descriptions are written for the model
 * and often continue with usage rules; the table shows the sentence that says
 * what the tool does, the panel shows all of it.
 */
export function descriptionSummary(description: string): string {
  return description.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}

/** The keys a tool declares that its own panel renders: provider credentials live in Credenziali. */
export function toolParamSpecs(tool: ToolState): RequiredSecretSpec[] {
  return (tool.requiredSecrets ?? []).filter((spec) => !PROVIDER_CREDENTIAL_KEYS.has(spec.key));
}

/** The provider credentials a tool declares, which the panel points to rather than renders. */
export function toolProviderSpecs(tool: ToolState): RequiredSecretSpec[] {
  return (tool.requiredSecrets ?? []).filter((spec) => PROVIDER_CREDENTIAL_KEYS.has(spec.key));
}

/**
 * The required keys a tool lacks. The same rule as the `tools-missing-secrets`
 * status check: the supervisor skips a tool whose non-optional key is unset.
 */
export function missingRequiredSpecs(
  tool: ToolState,
  isConfigured: (key: string) => boolean,
): RequiredSecretSpec[] {
  return (tool.requiredSecrets ?? []).filter((spec) => spec.optional !== true && !isConfigured(spec.key));
}

/** Every declared field once, first declaration wins: several tools of a plugin ask for the same key. */
export function uniqueSpecs(tools: readonly ToolState[]): RequiredSecretSpec[] {
  const byKey = new Map<string, RequiredSecretSpec>();
  for (const tool of tools) {
    for (const spec of tool.requiredSecrets ?? []) {
      if (!byKey.has(spec.key)) byKey.set(spec.key, spec);
    }
  }
  return [...byKey.values()];
}
