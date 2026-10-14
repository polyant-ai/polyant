// SPDX-License-Identifier: AGPL-3.0-or-later

import type { RequiredSecretSpec, ToolPluginInfo, ToolState } from "@/lib/api";
import { localizeText, type LocalizedText } from "@/lib/i18n/localized-text";
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
 * How a plugin is named in `locale`: its manifest's `displayName`, else its
 * namespace as a reader writes it. The fallback keeps plugins whose manifest
 * predates the field readable without asking their authors for anything.
 */
export function pluginName(namespace: string, plugins: readonly ToolPluginInfo[], locale: string): string {
  const displayName = plugins.find((p) => p.namespace === namespace)?.displayName;
  return displayName === undefined ? pluginLabel(namespace) : localizeText(displayName, locale);
}

/** A plugin's own sentence about itself in `locale`, when its manifest has one. */
export function pluginDescription(namespace: string, plugins: readonly ToolPluginInfo[], locale: string): string | null {
  const description = plugins.find((p) => p.namespace === namespace)?.description;
  return description === undefined ? null : localizeText(description, locale);
}

/** A plugin namespace as a reader writes it. */
export function pluginLabel(namespace: string): string {
  return namespace
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * The category ids the panel names in every locale. A tool's `category` is an id
 * its author picks, not text: built-in tools and plugins that share an id are
 * grouped together, and an id outside this list is shown as written, capitalized.
 */
const TOOL_CATEGORIES: Readonly<Record<string, LocalizedText>> = {
  accounting: { "en-US": "Accounting", "it-IT": "Contabilità" },
  agent: { "en-US": "Agents", "it-IT": "Agenti" },
  calendar: { "en-US": "Calendar", "it-IT": "Calendario" },
  communication: { "en-US": "Communication", "it-IT": "Comunicazione" },
  "conversation-trigger": { "en-US": "Conversation triggers", "it-IT": "Avvio conversazioni" },
  crm: { "en-US": "CRM", "it-IT": "CRM" },
  data: { "en-US": "Data", "it-IT": "Dati" },
  dev: { "en-US": "Development", "it-IT": "Sviluppo" },
  devops: { "en-US": "DevOps", "it-IT": "DevOps" },
  document: { "en-US": "Documents", "it-IT": "Documenti" },
  documents: { "en-US": "Documents", "it-IT": "Documenti" },
  ecommerce: { "en-US": "E-commerce", "it-IT": "E-commerce" },
  email: { "en-US": "Email", "it-IT": "Email" },
  erp: { "en-US": "ERP", "it-IT": "ERP" },
  files: { "en-US": "Files", "it-IT": "File" },
  general: { "en-US": "General", "it-IT": "Generale" },
  hr: { "en-US": "HR", "it-IT": "Risorse umane" },
  integration: { "en-US": "Integrations", "it-IT": "Integrazioni" },
  itsm: { "en-US": "IT service management", "it-IT": "Gestione servizi IT" },
  knowledge: { "en-US": "Knowledge", "it-IT": "Conoscenza" },
  marketing: { "en-US": "Marketing", "it-IT": "Marketing" },
  memory: { "en-US": "Memory", "it-IT": "Memoria" },
  messaging: { "en-US": "Messaging", "it-IT": "Messaggistica" },
  payments: { "en-US": "Payments", "it-IT": "Pagamenti" },
  plugin: { "en-US": "Plugin", "it-IT": "Plugin" },
  productivity: { "en-US": "Productivity", "it-IT": "Produttività" },
  prompts: { "en-US": "Prompts", "it-IT": "Prompt" },
  research: { "en-US": "Research", "it-IT": "Ricerca" },
  room: { "en-US": "Rooms", "it-IT": "Stanze" },
  skills: { "en-US": "Skills", "it-IT": "Skill" },
  storage: { "en-US": "Storage", "it-IT": "Archiviazione" },
  support: { "en-US": "Customer support", "it-IT": "Assistenza clienti" },
  whatsapp: { "en-US": "WhatsApp", "it-IT": "WhatsApp" },
  workspace: { "en-US": "Workspace", "it-IT": "Workspace" },
};

/** How `cat` is named in `locale`: the panel's own name for a known id, else the id capitalized. */
export function categoryLabel(cat: string, locale: string): string {
  const known = Object.hasOwn(TOOL_CATEGORIES, cat) ? TOOL_CATEGORIES[cat] : undefined;
  return known === undefined ? cat.charAt(0).toUpperCase() + cat.slice(1) : localizeText(known, locale);
}

/**
 * The first line of a tool description. Descriptions are written for the model
 * and often continue with usage rules; the panel shows all of it on request.
 */
export function descriptionSummary(description: string): string {
  return description.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}

/**
 * The sentence a person reads about a tool or a hook in `locale`: its author's
 * `summary`, else the first line of the description the model reads.
 */
export function capabilitySummary(
  capability: { description: string; summary?: LocalizedText },
  locale: string,
): string {
  return capability.summary === undefined
    ? descriptionSummary(capability.description)
    : localizeText(capability.summary, locale);
}

/** The keys a tool declares that its own panel renders: provider credentials live in the Modello section. */
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

/** The sentence a person reads about a hook function in `locale`: its `summary`, else its description. */
export function hookSummary(fn: { description: string; summary?: LocalizedText }, locale: string): string {
  return fn.summary === undefined ? fn.description : localizeText(fn.summary, locale);
}
