// SPDX-License-Identifier: AGPL-3.0-or-later

import { tool, jsonSchema, type Tool } from "ai";
import { z } from "zod";
import { existsSync, readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { pipelineLog } from "../../utils/pipeline-logger.js";
import { errMsg } from "../../utils/error.js";
import type { InstanceSlug } from "../../instances/identifiers.js";
import {
  normalizeRequiredSecrets,
  requiredSecretKeys,
  type RequiredSecretSpec,
  type RequiredSecretsInput,
  type ToolInfo,
  type ToolInputExample,
  type ToolDefinition as SerializedToolDefinition,
} from "@polyant-ai/plugin-sdk";
import { config } from "../../config.js";
import { resolvePluginRoots } from "../../plugin-system/plugin-roots.js";
import { engineSatisfies } from "../../plugin-system/plugin-manifest.js";

// Re-export the authoring contract from the SDK so core tools keep importing
// `normalizeRequiredSecrets` / the types from "./registry.js" unchanged.
export { normalizeRequiredSecrets, requiredSecretKeys };
export type { RequiredSecretSpec, RequiredSecretsInput, ToolInfo, ToolInputExample };
export type { SerializedToolDefinition };

// ---------------------------------------------------------------------------
// Directory where the core *.tool.(ts|js) files live (same dir as this file).
// ---------------------------------------------------------------------------

const __toolsDir = dirname(fileURLToPath(import.meta.url));

// Engine version, read lazily on first loadAllTools() so merely importing this
// module touches no fs (keeps partial fs mocks in tests working). Fail-closed to
// "0.0.0" so an unreadable package.json makes realistic engine ranges fail →
// incompatible plugins are skipped rather than wrongly loaded.
let _engineVersion: string | undefined;
function getEngineVersion(): string {
  if (_engineVersion !== undefined) return _engineVersion;
  try {
    _engineVersion = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ).version as string;
  } catch {
    _engineVersion = "0.0.0";
  }
  return _engineVersion;
}

// ---------------------------------------------------------------------------
// Runtime context passed to every tool (engine-concrete; the SDK mirrors this
// structurally so serialized plugin tools authored against the SDK still accept
// this object).
// ---------------------------------------------------------------------------

export interface ToolContext {
  /** Instance identifier (slug, not UUID). */
  instanceId: InstanceSlug;
  /** Per-instance decrypted secrets. */
  secrets?: Record<string, string>;
  /** Audit logger scoped to this tool + instance + conversation. */
  audit: import("../../audit/audit-logger.js").AuditLogger;
  /** Conversation ID for correlation in audit logs. */
  conversationId?: string;
  /** Attachments from the current user message (images, files, etc.). */
  attachments?: import("../../channels/types.js").Attachment[];
  /** Per-instance API keys for AI provider calls. */
  apiKeys?: import("../../ai-gateway/types.js").ChatRequest["apiKeys"];
  /** AI provider name (e.g. "openai", "anthropic") for tool-level LLM calls. */
  provider?: string;
  /** Shared per-conversation key/value state (trusted, tool-to-tool). */
  state?: import("../../conversations/state.buffer.js").ConversationStateApi;
}

// ---------------------------------------------------------------------------
// Definition shapes
//
// Two coexist during the migration to the serialized contract:
//   - LegacyToolDefinition: `create(ctx) => { parameters: Zod, execute }` — the
//     old self-registering (`registerTool`) core tools.
//   - SerializedToolDefinition (from the SDK): `inputSchema: JSON Schema` +
//     `execute(input, ctx)` — authored via `defineTool`, `export default`ed, and
//     collected by the loader. This is the target shape for ALL tools + plugins.
// `buildTool` dispatches on the presence of `inputSchema`.
// ---------------------------------------------------------------------------

/** Legacy self-registered tool definition (create-factory shape). */
export interface LegacyToolDefinition {
  name: string;
  description: string;
  category?: string;
  requiredEnv?: string[];
  requiredSecrets?: RequiredSecretsInput;
  metaTool?: boolean;
  harness?: boolean;
  inputExamples?: ToolInputExample[];
  create: (ctx: ToolContext) => {
    parameters: z.ZodType;
    execute: (params: any) => Promise<unknown>;
  };
}

/** What the registry stores — either the legacy or the serialized shape. */
export type ToolDefinition = LegacyToolDefinition | SerializedToolDefinition;

/** Type guard: a serialized (defineTool / export-default) definition. */
export function isSerializedTool(def: ToolDefinition): def is SerializedToolDefinition {
  return "inputSchema" in def;
}

// ---------------------------------------------------------------------------
// Registry (engine-owned singleton Map — the loader is its only writer).
// ---------------------------------------------------------------------------

const registry = new Map<string, ToolDefinition>();

/** Active plugin namespace applied to legacy `registerTool` side-effects during
 * a plugin root's import. Core tools load with no namespace (flat names). */
let activeNamespace: string | null = null;

export function setActivePluginNamespace(ns: string | null): void {
  activeNamespace = ns;
}

/** TEST ONLY: clear the registry between unit tests. */
export function _resetRegistryForTests(): void {
  registry.clear();
  activeNamespace = null;
}

function assertUniqueName(finalName: string): void {
  if (registry.has(finalName)) {
    throw new Error(`Duplicate tool registration: "${finalName}" is already registered.`);
  }
}

/**
 * Legacy registration path: a `*.tool.ts` file calls this as a module side-effect.
 * The active plugin namespace (if any) is applied as a `<ns>:<name>` prefix.
 */
export function registerTool(definition: LegacyToolDefinition): void {
  const finalName = activeNamespace ? `${activeNamespace}:${definition.name}` : definition.name;
  assertUniqueName(finalName);
  // Fail fast on malformed requiredSecrets specs (e.g. select without choices).
  normalizeRequiredSecrets(definition.requiredSecrets, finalName);
  // Only clone to rewrite the name when a namespace applies; otherwise store the
  // exact definition (preserves reference identity for the common core path).
  registry.set(finalName, activeNamespace ? { ...definition, name: finalName } : definition);
}

/** New registration path: the loader collects an `export default defineTool(...)`. */
function registerSerialized(def: SerializedToolDefinition, namespace: string | null): void {
  const finalName = namespace ? `${namespace}:${def.name}` : def.name;
  assertUniqueName(finalName);
  registry.set(finalName, namespace ? { ...def, name: finalName } : def);
}

/** Read-only view of the full registry. */
export function getToolRegistry(): ReadonlyMap<string, ToolDefinition> {
  return registry;
}

// ---------------------------------------------------------------------------
// buildTool + helpers
// ---------------------------------------------------------------------------

/**
 * Fill keys missing from `val` with `null` for a Zod object schema. Strict-mode
 * schemas mark every key required-but-nullable; non-strict models legitimately
 * omit irrelevant fields. Shared by the legacy `buildTool` path and the hooks
 * tool-action executor.
 */
export function fillMissingKeysWithNull(parameters: z.ZodType, val: unknown): unknown {
  if (!(parameters instanceof z.ZodObject)) return val;
  if (!val || typeof val !== "object" || Array.isArray(val)) return val;
  const shape = (parameters as z.ZodObject<z.ZodRawShape>).shape;
  const filled: Record<string, unknown> = { ...(val as Record<string, unknown>) };
  for (const key of Object.keys(shape)) {
    if (!(key in filled)) filled[key] = null;
  }
  return filled;
}

/** Recursive JSON-Schema-driven equivalent of `fillMissingKeysWithNull`: fills
 * missing object keys with `null` at every depth (nested objects + array items).
 * This mirrors, for the serialized path, what the legacy Zod `z.preprocess` did
 * inline — so non-strict models that omit nullable keys (incl. NESTED ones, e.g.
 * a filter's alias field) still pass validation instead of being rejected. */
export function fillMissingKeysFromJsonSchema(schema: Record<string, unknown>, val: unknown): unknown {
  if (!schema || typeof schema !== "object") return val;
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (props && val && typeof val === "object" && !Array.isArray(val)) {
    const filled: Record<string, unknown> = { ...(val as Record<string, unknown>) };
    for (const key of Object.keys(props)) {
      if (!(key in filled)) filled[key] = null;
      else filled[key] = fillMissingKeysFromJsonSchema(props[key], filled[key]);
    }
    return filled;
  }
  const items = schema.items as Record<string, unknown> | undefined;
  if (items && Array.isArray(val)) {
    return val.map((item) => fillMissingKeysFromJsonSchema(items, item));
  }
  return val;
}

/**
 * Least-privilege wrapper for a tool's secrets: reads of keys the tool declared
 * in `requiredSecrets` pass through; an UNDECLARED read is logged once per key
 * and, in enforce mode, denied (returns undefined). Default (shadow) mode returns
 * the value so existing under-declared plugins keep working while the warnings
 * surface the gaps — flip `TOOL_SECRET_SCOPE_ENFORCE=true` once every plugin
 * declares its full (transitive) secret set. Third-party plugin code should never
 * read secrets it didn't declare; this is the boundary that makes that true.
 * ponytail: keyed-access only — `secrets?.["k"]` / `secrets?.k` are covered;
 * `{...secrets}` / `Object.keys(secrets)` bypass the get trap. Tighten with an
 * ownKeys trap if a plugin is found enumerating the bag.
 */
export function scopeSecrets(
  secrets: Record<string, string> | undefined,
  declared: ReadonlySet<string>,
  toolName: string,
  enforce: boolean,
): Record<string, string> | undefined {
  if (!secrets) return secrets;
  const warned = new Set<string>();
  return new Proxy(secrets, {
    get(target, prop, receiver) {
      if (typeof prop !== "string" || declared.has(prop) || !(prop in target)) {
        return Reflect.get(target, prop, receiver);
      }
      if (!warned.has(prop)) {
        warned.add(prop);
        console.warn(
          `Tool "${toolName}" read undeclared secret "${prop}" — add it to requiredSecrets` +
            (enforce ? " (DENIED: scope enforcement on)" : " (allowed: shadow mode)"),
        );
      }
      return enforce ? undefined : Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (enforce && typeof prop === "string" && prop in target && !declared.has(prop)) return false;
      return Reflect.has(target, prop);
    },
  });
}

/** Append `inputExamples` as text to a tool description (raw, no schema validation). */
function appendExamplesRaw(description: string, examples: ToolInputExample[]): string {
  const text = examples.map((ex) => `  ${ex.label}: ${JSON.stringify(ex.input)}`).join("\n");
  return `${description}\n\nInput examples:\n${text}`;
}

function buildLegacyTool(def: LegacyToolDefinition, ctx: ToolContext): Tool {
  const { parameters, execute } = def.create(ctx);

  let description = def.description;
  if (def.inputExamples?.length) {
    // Validate examples against the partial schema so missing-but-nullable fields
    // don't reject an illustrative subset; drop invalid ones with a warning.
    const exampleSchema =
      "partial" in parameters && typeof (parameters as { partial?: unknown }).partial === "function"
        ? (parameters as unknown as z.ZodObject<z.ZodRawShape>).partial()
        : parameters;
    const valid = def.inputExamples.filter((ex) => {
      const result = exampleSchema.safeParse(ex.input);
      if (!result.success) {
        console.warn(`Tool "${def.name}": example "${ex.label}" failed validation:`, result.error.format());
        return false;
      }
      return true;
    });
    if (valid.length > 0) description = appendExamplesRaw(description, valid);
  }

  const wrappedExecute = async (params: unknown) => {
    pipelineLog.toolCall(ctx.instanceId, def.name, params as Record<string, unknown>);
    try {
      const result = await execute(params);
      pipelineLog.toolResult(ctx.instanceId, def.name, true);
      return result;
    } catch (err) {
      pipelineLog.toolResult(ctx.instanceId, def.name, false, errMsg(err));
      throw err;
    }
  };

  const runtimeParameters =
    parameters instanceof z.ZodObject
      ? (z.preprocess((val) => fillMissingKeysWithNull(parameters, val), parameters) as unknown as typeof parameters)
      : parameters;

  return tool({ description, inputSchema: runtimeParameters, execute: wrappedExecute });
}

function buildSerializedTool(def: SerializedToolDefinition, ctx: ToolContext): Tool {
  let description = def.description;
  if (def.inputExamples?.length) description = appendExamplesRaw(description, def.inputExamples);

  const wrappedExecute = async (input: unknown) => {
    pipelineLog.toolCall(ctx.instanceId, def.name, input as Record<string, unknown>);
    try {
      const result = await def.execute(input, ctx);
      pipelineLog.toolResult(ctx.instanceId, def.name, true);
      return result;
    } catch (err) {
      pipelineLog.toolResult(ctx.instanceId, def.name, false, errMsg(err));
      throw err;
    }
  };

  // Fill missing nullable keys (recursively) INSIDE validation — the serialized
  // analogue of the legacy z.preprocess — so non-strict models that omit keys
  // still validate. The tool's own execute performs semantic validation.
  return tool({
    description,
    inputSchema: jsonSchema(def.inputSchema as Parameters<typeof jsonSchema>[0], {
      validate: (value: unknown) => ({
        success: true as const,
        value: fillMissingKeysFromJsonSchema(def.inputSchema, value),
      }),
    }),
    execute: wrappedExecute,
  });
}

/**
 * Build a Vercel AI SDK `Tool` from a registered definition + runtime context,
 * dispatching on the definition shape (serialized vs legacy).
 */
export function buildTool(def: ToolDefinition, ctx: ToolContext): Tool {
  return isSerializedTool(def) ? buildSerializedTool(def, ctx) : buildLegacyTool(def, ctx);
}

/** Map the registry to a serializable array of tool info objects. */
export function listAvailableTools(): ToolInfo[] {
  return Array.from(registry.values())
    .filter((def) => !def.harness)
    .map((def) => {
      const specs = normalizeRequiredSecrets(def.requiredSecrets, def.name);
      return {
        name: def.name,
        description: def.description,
        category: def.category ?? "general",
        requiredSecrets: specs.length > 0 ? specs : undefined,
        ...(def.inputExamples?.length ? { inputExamples: def.inputExamples } : {}),
      };
    });
}

// ---------------------------------------------------------------------------
// Loader: scan core dir (no namespace) then each plugin root under its namespace.
// ---------------------------------------------------------------------------

/** Import every `*.tool.(ts|js)` in `dir`. Serialized defs (`export default`) are
 * collected; legacy tools self-register via `registerTool` (namespaced by the
 * active namespace). */
async function importRoot(dir: string, namespace: string | null): Promise<void> {
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter((f) => /\.tool\.(ts|js)$/.test(f));
  setActivePluginNamespace(namespace);
  try {
    for (const file of files) {
      try {
        const mod = (await import(join(dir, file))) as { default?: unknown };
        const def = mod.default;
        if (def && typeof def === "object" && "inputSchema" in (def as object)) {
          registerSerialized(def as SerializedToolDefinition, namespace);
        }
        // else: a legacy tool already self-registered as a side-effect.
      } catch (err) {
        // Third-party plugin code must never abort engine boot: log + skip the
        // offending file. Core tools (no namespace) are first-party — a broken
        // core tool is a real bug, so rethrow to fail loudly at boot.
        if (namespace === null) throw err;
        console.warn(
          `Plugin "${namespace}" tool file "${file}" failed to load: ${errMsg(err)} — skipping`,
        );
      }
    }
  } finally {
    setActivePluginNamespace(null);
  }
}

/**
 * Discover + load all tools: the core tools dir (flat names) plus every plugin
 * root resolved from `PLUGIN_DIRS` + the convention dir (`src|dist/plugins/*`),
 * each under its manifest namespace. Plugins outside the engine version range are
 * skipped with a warning. Finally, tools whose `requiredEnv` vars are unset are
 * pruned.
 */
export async function loadAllTools(): Promise<void> {
  await importRoot(__toolsDir, null);

  const conventionDir = join(__toolsDir, "..", "..", "plugins");
  const roots = resolvePluginRoots({ envDirs: config.plugins.dirs, conventionDir });
  for (const { root, manifest } of roots) {
    if (!engineSatisfies(manifest, getEngineVersion())) {
      console.warn(
        `Plugin "${manifest.name}" requires engine ${manifest.engine}, have ${getEngineVersion()} — skipping`,
      );
      continue;
    }
    await importRoot(join(root, manifest.toolsDir), manifest.namespace);
  }
  setActivePluginNamespace(null);

  // Prune tools with missing env vars.
  for (const [name, def] of registry) {
    if (def.requiredEnv && def.requiredEnv.length > 0) {
      // CONVENTION-EXCEPTION: reads process.env intentionally for tool discovery;
      // checks presence/absence of arbitrary vars declared by tools themselves
      // (requiredEnv), not known to the config.ts schema. See CLAUDE.md.
      const missing = def.requiredEnv.filter((envVar) => !process.env[envVar]);
      if (missing.length > 0) {
        registry.delete(name);
        console.warn(`Tool "${name}" disabled: missing env var(s) ${missing.join(", ")}`);
      }
    }
  }
}
