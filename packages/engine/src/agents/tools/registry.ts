// SPDX-License-Identifier: AGPL-3.0-or-later

import { tool, jsonSchema, type Tool } from "ai";
import Ajv, { type ValidateFunction } from "ajv";
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
import { findStrictModeViolations } from "./strict-mode-lint.js";

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
// Definition shape
//
// Every tool is a SerializedToolDefinition (from the SDK): `inputSchema` (a JSON
// Schema — data, not a live Zod object) + `execute(input, ctx)`, authored via
// `defineTool` and `export default`ed, collected by the loader.
// ---------------------------------------------------------------------------

/** What the registry stores. Alias kept for the many importers of this name. */
export type ToolDefinition = SerializedToolDefinition;

// ---------------------------------------------------------------------------
// Registry (engine-owned singleton Map — the loader is its only writer).
// ---------------------------------------------------------------------------

const registry = new Map<string, ToolDefinition>();

/** TEST ONLY: clear the registry between unit tests. */
export function _resetRegistryForTests(): void {
  registry.clear();
}

function assertUniqueName(finalName: string): void {
  if (registry.has(finalName)) {
    throw new Error(`Duplicate tool registration: "${finalName}" is already registered.`);
  }
}

/** Register a serialized definition under an optional plugin namespace. The
 * loader is the only caller; tests use `_registerToolForTests`. */
function registerSerialized(def: SerializedToolDefinition, namespace: string | null): void {
  const finalName = namespace ? `${namespace}:${def.name}` : def.name;
  assertUniqueName(finalName);
  registry.set(finalName, namespace ? { ...def, name: finalName } : def);
}

/** TEST ONLY: register a serialized tool definition directly (bypasses the loader). */
export function _registerToolForTests(def: SerializedToolDefinition, namespace: string | null = null): void {
  registerSerialized(def, namespace);
}

/** Read-only view of the full registry. */
export function getToolRegistry(): ReadonlyMap<string, ToolDefinition> {
  return registry;
}

// ---------------------------------------------------------------------------
// buildTool + helpers
// ---------------------------------------------------------------------------

/** Fill missing object keys with `null`, recursing into nested objects + array
 * items. Non-strict models omit nullable keys at any depth (e.g. a filter's alias
 * field); those must be filled so validation doesn't reject them. */
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

// JSON Schema validator for the serialized path. Configured to MIRROR Zod
// semantics (the legacy path validated with the source Zod schema): strip
// unknown keys (`removeAdditional`, like a non-strict z.object) and DON'T coerce
// types (a string where a number is declared is rejected, like Zod). This
// restores validation parity for non-strict models — strict-mode providers
// already validate upstream, but non-strict ones (many Bedrock models, some
// OpenAI-compatible endpoints) can emit off-schema args, which previously
// reached execute unchecked. The tool schemas are strict-mode-compatible (no
// exotic constructs — those live in execute per rule-7), so ajv on the derived
// JSON Schema tracks Zod faithfully.
const ajv = new Ajv({ removeAdditional: "all", coerceTypes: false, useDefaults: false, allErrors: false });
const validatorCache = new WeakMap<object, ValidateFunction | null>();

function getValidator(schema: Record<string, unknown>): ValidateFunction | null {
  if (validatorCache.has(schema)) return validatorCache.get(schema) ?? null;
  let compiled: ValidateFunction | null = null;
  try {
    compiled = ajv.compile(schema);
  } catch (err) {
    // A schema ajv can't compile degrades to fill-only (today's behaviour) rather
    // than breaking the tool — validation is best-effort parity, not a hard gate.
    console.warn(`Tool schema failed to compile for validation — skipping: ${errMsg(err)}`);
  }
  validatorCache.set(schema, compiled);
  return compiled;
}

/**
 * Fill missing nullable keys (recursively) then validate against the JSON Schema.
 * Shared by the serialized `buildTool` path and the hooks tool-action executor so
 * both validate identically. Returns the (possibly extra-key-stripped) value on
 * success, or an error message on failure.
 */
export function fillAndValidate(
  schema: Record<string, unknown>,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const filled = fillMissingKeysFromJsonSchema(schema, value);
  const validator = getValidator(schema);
  if (!validator || validator(filled)) return { ok: true, value: filled };
  return { ok: false, error: ajv.errorsText(validator.errors) };
}

/**
 * Least-privilege: return a NEW secrets object containing ONLY the keys the tool
 * declared in `requiredSecrets`. A tool — especially third-party plugin code —
 * can never read another integration's credentials it did not declare. This is a
 * hard boundary (not a warning): undeclared keys are simply absent, so every
 * access pattern (`secrets?.["k"]`, destructuring, spread, `Object.keys`) sees
 * only the declared subset. A tool that reads an undeclared secret must add it to
 * `requiredSecrets`.
 */
export function scopeSecrets(
  secrets: Record<string, string> | undefined,
  declared: ReadonlySet<string>,
): Record<string, string> | undefined {
  if (!secrets) return secrets;
  const scoped: Record<string, string> = {};
  for (const key of declared) {
    if (key in secrets) scoped[key] = secrets[key];
  }
  return scoped;
}

/** Append `inputExamples` as text to a tool description (raw, no schema validation). */
function appendExamplesRaw(description: string, examples: ToolInputExample[]): string {
  const text = examples.map((ex) => `  ${ex.label}: ${JSON.stringify(ex.input)}`).join("\n");
  return `${description}\n\nInput examples:\n${text}`;
}

/**
 * Build a Vercel AI SDK `Tool` from a registered definition + runtime context.
 */
export function buildTool(def: ToolDefinition, ctx: ToolContext): Tool {
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

  // Fill missing nullable keys (recursively) THEN validate against the JSON
  // Schema — the serialized analogue of the legacy Zod validation path. Fill so
  // non-strict models that omit nullable keys still pass; validate so off-schema
  // args (wrong type, hallucinated keys) get a correctable error instead of
  // silently reaching execute. The tool's own execute still does semantic checks.
  return tool({
    description,
    inputSchema: jsonSchema(def.inputSchema as Parameters<typeof jsonSchema>[0], {
      validate: (value: unknown) => {
        const r = fillAndValidate(def.inputSchema, value);
        return r.ok
          ? { success: true as const, value: r.value }
          : { success: false as const, error: new Error(r.error) };
      },
    }),
    execute: wrappedExecute,
  });
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
 * collected. A file without a `defineTool` default export is skipped with a warn. */
async function importRoot(dir: string, namespace: string | null): Promise<void> {
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter((f) => /\.tool\.(ts|js)$/.test(f));
  for (const file of files) {
    try {
      const mod = (await import(join(dir, file))) as { default?: unknown };
      const def = mod.default;
      if (def && typeof def === "object" && "inputSchema" in (def as object)) {
        const serialized = def as SerializedToolDefinition;
        registerSerialized(serialized, namespace);
        // Load-time strict-mode lint for PLUGIN tools (core tools are covered by
        // strict-mode.test.ts). Third-party schemas get no engine-side check
        // otherwise — a violation would only surface as a cryptic provider
        // rejection at call time. Warn, don't fail: the plugin still loads.
        if (namespace !== null) {
          const violations = findStrictModeViolations(serialized.inputSchema, `${namespace}:${serialized.name}`);
          for (const v of violations) {
            console.warn(`Plugin tool strict-mode lint: ${v}`);
          }
        }
      } else {
        console.warn(`Tool file "${file}" has no defineTool default export — skipping`);
      }
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
