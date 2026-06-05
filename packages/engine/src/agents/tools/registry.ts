// SPDX-License-Identifier: AGPL-3.0-or-later

import { tool, type Tool } from "ai";
import { z } from "zod";
import { readdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { pipelineLog } from "../../utils/pipeline-logger.js";
import { errMsg } from "../../utils/error.js";
import type { InstanceSlug } from "../../instances/identifiers.js";
// ---------------------------------------------------------------------------
// Directory where *.tool.(ts|js) files live (same dir as this registry file)
// ---------------------------------------------------------------------------

const __toolsDir = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Runtime context passed to every tool factory. */
export interface ToolContext {
  /** Instance identifier (slug, not UUID). Used by tool-level operations. */
  instanceId: InstanceSlug;
  /** Per-instance decrypted secrets. */
  secrets?: Record<string, string>;
  /** Audit logger scoped to this tool + instance + conversation. */
  audit: import("../../audit/audit-logger.js").AuditLogger;
  /** Conversation ID for correlation in audit logs. */
  conversationId?: string;
  /** Attachments from the current user message (images, files, etc.). */
  attachments?: import("../../channels/types.js").Attachment[];
  /** Per-instance API keys for AI provider calls (used by tools like verifyDocument). */
  apiKeys?: import("../../ai-gateway/types.js").ChatRequest["apiKeys"];
  /** AI provider name (e.g. "openai", "anthropic") for tool-level LLM calls. */
  provider?: string;
}

/**
 * Describes a single per-instance config field that a tool needs to operate.
 *
 * `type === "text"` is the default secret/key case (free-text input, masked in UI).
 * `type === "select"` exposes a fixed set of `choices` — used when the tool offers
 * a provider/engine/mode choice (e.g. webSearch provider: tavily | serpapi | duckduckgo).
 *
 * Stored as a row in `instance_secrets` like any other key. The framework does NOT
 * enforce `optional` cross-field semantics (e.g. "required only if another field
 * equals X") — that conditional logic stays inside the tool's `execute()`.
 */
export interface RequiredSecretSpec {
  key: string;
  type: "text" | "select";
  /** Human-readable label for the admin UI. Defaults to a humanized form of `key`. */
  label?: string;
  /** Optional help text shown under the field in the admin UI. */
  description?: string;
  /** Allowed values when `type === "select"`. Must be non-empty for select fields. */
  choices?: string[];
  /** When true, the field can be left empty without flagging the tool as misconfigured. */
  optional?: boolean;
}

/**
 * Input form accepted by `registerTool()`: either a bare string (legacy, shorthand
 * for `{ key, type: "text" }`) or a full spec. Mixed arrays are allowed.
 */
export type RequiredSecretsInput = ReadonlyArray<string | RequiredSecretSpec>;

/** What each tool file declares via `registerTool()`. */
export interface ToolDefinition {
  name: string;
  description: string;
  category?: string;
  /** Env vars that must be set for this tool to be available (legacy, checked at boot). */
  requiredEnv?: string[];
  /**
   * Per-instance config fields required for this tool. Each entry can be:
   * - a string `"k"` (shorthand for `{ key: "k", type: "text" }`)
   * - a `RequiredSecretSpec` for typed fields (e.g. selects with `choices`)
   */
  requiredSecrets?: RequiredSecretsInput;
  /** Meta-tools are built separately by the supervisor (e.g. spawnTask needs other built tools). */
  metaTool?: boolean;
  /** Harness tools are hidden from the admin UI and only equipped when the supervisor runs with a matching `includeHarness` set. */
  harness?: boolean;
  /** Optional input examples shown to the LLM alongside the schema. Validated against the Zod schema at build time. */
  inputExamples?: Array<{
    /** Brief label (e.g., "Crea task ricorrente cron") */
    label: string;
    /** Example input — must validate against the tool's Zod schema */
    input: Record<string, unknown>;
  }>;
  /** Factory that produces parameters + execute for a given runtime context. */
  create: (ctx: ToolContext) => {
    parameters: z.ZodType;
    execute: (params: any) => Promise<unknown>;
  };
}

/** Serializable info for the admin panel. */
export interface ToolInfo {
  name: string;
  description: string;
  category: string;
  requiredSecrets?: RequiredSecretSpec[];
  inputExamples?: Array<{ label: string; input: Record<string, unknown> }>;
}

/**
 * Normalize a `RequiredSecretsInput` (mixed string + spec) into a uniform
 * `RequiredSecretSpec[]`. Throws on malformed specs so misconfiguration is
 * caught at registry-load time, not at runtime.
 *
 * @param input  declared `requiredSecrets` (or undefined)
 * @param toolName  optional tool name, prepended to error messages so a
 *                  contributor sees which tool produced the malformed spec
 *                  instead of a generic "RequiredSecretSpec missing 'key'".
 */
export function normalizeRequiredSecrets(
  input: RequiredSecretsInput | undefined,
  toolName?: string,
): RequiredSecretSpec[] {
  if (!input) return [];
  const prefix = toolName ? `Tool "${toolName}": ` : "";
  return input.map((entry, index) => {
    if (typeof entry === "string") {
      // Reject empty strings — they'd produce a `{ key: "" }` spec that
      // breaks the admin UI and never resolves to a real secret.
      if (entry.length === 0) {
        throw new Error(
          `${prefix}requiredSecrets[${index}] is an empty string. Use a non-empty key (lowercase snake_case, e.g. "openai_api_key") or a full RequiredSecretSpec.`,
        );
      }
      return { key: entry, type: "text" as const };
    }
    if (!entry.key) {
      throw new Error(
        `${prefix}requiredSecrets[${index}] missing 'key'.`,
      );
    }
    if (entry.type === "select") {
      if (!entry.choices || entry.choices.length === 0) {
        throw new Error(
          `${prefix}requiredSecrets[${index}] "${entry.key}": type 'select' requires non-empty 'choices'.`,
        );
      }
    }
    return entry;
  });
}

/** Extract just the secret key names from a normalized spec list. */
export function requiredSecretKeys(input: RequiredSecretsInput | undefined): string[] {
  return normalizeRequiredSecrets(input).map((s) => s.key);
}

// ---------------------------------------------------------------------------
// Global registry
// ---------------------------------------------------------------------------

const registry = new Map<string, ToolDefinition>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a tool definition. Throws if a tool with the same name already
 * exists (prevents silent overwrites from duplicate imports).
 */
export function registerTool(definition: ToolDefinition): void {
  if (registry.has(definition.name)) {
    throw new Error(
      `Duplicate tool registration: "${definition.name}" is already registered.`,
    );
  }
  // Fail fast on malformed requiredSecrets specs (e.g. select without choices).
  // Pass the tool name so the error blames the right file.
  normalizeRequiredSecrets(definition.requiredSecrets, definition.name);
  registry.set(definition.name, definition);
}

/**
 * Returns a read-only view of the full registry.
 */
export function getToolRegistry(): ReadonlyMap<string, ToolDefinition> {
  return registry;
}

/**
 * Build a Vercel AI SDK `Tool` from a `ToolDefinition` + runtime context.
 *
 * The description is taken from the definition (not from `create()`), ensuring
 * consistent metadata regardless of what the factory returns.
 */
export function buildTool(def: ToolDefinition, ctx: ToolContext): Tool {
  const { parameters, execute } = def.create(ctx);

  let description = def.description;
  if (def.inputExamples?.length) {
    // Examples are illustrative subsets — they intentionally omit fields not
    // relevant to the action they demonstrate. Validate them against the
    // partial schema so missing-but-nullable fields don't reject the example.
    const exampleSchema =
      "partial" in parameters && typeof (parameters as { partial?: unknown }).partial === "function"
        ? (parameters as unknown as z.ZodObject<z.ZodRawShape>).partial()
        : parameters;
    const valid = def.inputExamples.filter((ex) => {
      const result = exampleSchema.safeParse(ex.input);
      if (!result.success) {
        console.warn(
          `Tool "${def.name}": example "${ex.label}" failed validation:`,
          result.error.format(),
        );
        return false;
      }
      return true;
    });
    if (valid.length > 0) {
      const text = valid
        .map((ex) => `  ${ex.label}: ${JSON.stringify(ex.input)}`)
        .join("\n");
      description += `\n\nInput examples:\n${text}`;
    }
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

  // Schema with .nullable() on every field is required for OpenAI strict mode
  // (gpt-5 / o-series with thinking) to keep all keys in `required`. Models
  // that don't run in strict mode (e.g. gpt-4.1, Claude) still omit irrelevant
  // fields, which would fail the strict schema at runtime. Wrap the schema in
  // a preprocess that fills missing keys with `null` so non-strict models keep
  // working without weakening the JSON schema sent to OpenAI.
  const runtimeParameters = parameters instanceof z.ZodObject
    ? (z.preprocess((val) => {
        if (!val || typeof val !== "object" || Array.isArray(val)) return val;
        const shape = (parameters as z.ZodObject<z.ZodRawShape>).shape;
        const filled: Record<string, unknown> = { ...(val as Record<string, unknown>) };
        for (const key of Object.keys(shape)) {
          if (!(key in filled)) filled[key] = null;
        }
        return filled;
      }, parameters) as unknown as typeof parameters)
    : parameters;

  return tool({ description, inputSchema: runtimeParameters, execute: wrappedExecute });
}

/**
 * Map the registry to a serializable array of tool info objects.
 */
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

/**
 * Scan the tools directory for `*.tool.(ts|js)` files and dynamic-import
 * each one. Each file is expected to call `registerTool()` as a side effect
 * at module level.
 *
 * After all imports complete, tools whose `requiredEnv` vars are not set in
 * `process.env` are pruned from the registry.
 */
export async function loadAllTools(): Promise<void> {
  const entries = readdirSync(__toolsDir);
  const toolFiles = entries.filter((f) => /\.tool\.(ts|js)$/.test(f));

  // Dynamic-import each tool file (triggers registerTool side effects)
  await Promise.all(
    toolFiles.map((file) => import(join(__toolsDir, file))),
  );

  // Prune tools with missing env vars
  for (const [name, def] of registry) {
    if (def.requiredEnv && def.requiredEnv.length > 0) {
      // CONVENTION-EXCEPTION: reads process.env intentionally for tool discovery;
      // checks presence/absence of arbitrary vars declared by tools themselves
      // (requiredEnv), not known to the config.ts schema. See CLAUDE.md.
      const missing = def.requiredEnv.filter(
        (envVar) => !process.env[envVar],
      );
      if (missing.length > 0) {
        registry.delete(name);
        console.warn(
          `Tool "${name}" disabled: missing env var(s) ${missing.join(", ")}`,
        );
      }
    }
  }
}
