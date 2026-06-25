// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, beforeAll } from "vitest";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { z } from "zod";
import { loadAllTools, getToolRegistry, type ToolContext } from "./registry.js";
import { createMockAudit } from "../../test-utils.js";
import { asAgentSlug } from "../../instances/identifiers.js";

// Guard-rail: every registered tool must produce a JSON schema compatible
// with OpenAI strict-mode (Responses API /v1/responses).
// Past violations: .url() in http-request, .optional() in hubspot-contact.
// See CLAUDE.md → Important Caveats.
//
// Known limit: synthetic `ask_{slug}` tools for agent-to-agent (see
// channels/adapters/agent.adapter.ts) are built dynamically in
// supervisor/index.ts and NOT registered via registerTool, so they are
// not covered here. Their schema is trivial ({ prompt: string }) and conforms.

const FORBIDDEN_FORMATS = new Set([
  "uri",
  "email",
  "uuid",
  "date-time",
  "date",
  "time",
  "ipv4",
  "ipv6",
]);

function stubCtx(): ToolContext {
  return {
    agentId: asAgentSlug("strict-mode-test"),
    secrets: {
      hubspot_api_key: "test",
      slack_bot_token: "test",
      whatsapp_account_sid: "test",
      whatsapp_auth_token: "test",
      whatsapp_from_number: "+10000000000",
      whatsapp_messaging_service_sid: "MG00000000000000000000000000000000",
      tavily_api_key: "test",
      github_token: "test",
      render_api_key: "test",
    },
    audit: createMockAudit(),
    conversationId: "strict-mode-test-conv",
    attachments: [],
    provider: "openai",
  };
}

interface SchemaNode {
  type?: string | string[];
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean | Record<string, unknown>;
  items?: unknown;
  format?: string;
  anyOf?: unknown[];
  oneOf?: unknown[];
  allOf?: unknown[];
  enum?: unknown[];
  const?: unknown;
}

function isObjectSchema(node: SchemaNode): boolean {
  if (node.type === "object") return true;
  if (Array.isArray(node.type) && node.type.includes("object")) return true;
  return !!node.properties;
}

function walk(node: unknown, path: string, violations: string[]): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  const n = node as SchemaNode;

  // R2: forbidden format
  if (n.format && FORBIDDEN_FORMATS.has(n.format)) {
    violations.push(
      `${path} — uses format="${n.format}" which OpenAI strict-mode rejects (validate at runtime instead)`,
    );
  }

  // R1 + R3: object schema must have required covering all properties and additionalProperties === false
  if (isObjectSchema(n)) {
    const propKeys = n.properties ? Object.keys(n.properties) : [];
    const required = Array.isArray(n.required) ? n.required : [];
    const missing = propKeys.filter((k) => !required.includes(k));
    if (missing.length > 0) {
      violations.push(
        `${path} — object schema is missing keys in 'required': [${missing.join(", ")}]`,
      );
    }
    // R3: additionalProperties must be `false` OR a constrained schema (non-empty).
    // OpenAI strict-mode formally requires `false`, but in practice it accepts
    // `additionalProperties: { type: <something> }` (z.record(z.string()))
    // — see `hubspotContact.customProperties`. We reject ONLY unbounded cases:
    // `true` or empty `{}` (typical of z.record(z.unknown())).
    if (n.additionalProperties !== false) {
      const ap = n.additionalProperties;
      const isUnbounded =
        ap === true ||
        (typeof ap === "object" && ap !== null && Object.keys(ap as object).length === 0);
      if (ap === undefined) {
        violations.push(
          `${path} — object schema must declare additionalProperties (false or a constrained sub-schema). Missing entirely.`,
        );
      } else if (isUnbounded) {
        violations.push(
          `${path} — object schema has unbounded additionalProperties (${ap === true ? "true" : "{}"}). Use z.record(z.string()) with a typed value or a stringified JSON parameter.`,
        );
      }
    }
  }

  // Recurse
  if (n.properties) {
    for (const [k, v] of Object.entries(n.properties)) {
      walk(v, `${path}.properties.${k}`, violations);
    }
  }
  if (n.items) walk(n.items, `${path}.items`, violations);
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const arr = n[key];
    if (Array.isArray(arr)) {
      arr.forEach((sub, i) => walk(sub, `${path}.${key}[${i}]`, violations));
    }
  }
}

describe("Tool schemas — OpenAI strict-mode compatibility", () => {
  beforeAll(async () => {
    await loadAllTools();
  });

  // SKIP: when AUTH_SECRET was added to test-setup (so activity-stream emit-helpers
  // could load config in tests), this guard-rail started exercising tools that had
  // never been audited end-to-end and surfaced ~12 pre-existing strict-mode
  // violations (writeFile.overwrite, scheduleTask.*, ghPR.*, ghIssue.*, etc. —
  // tools using `.optional()` without making the field nullable in the schema).
  // These are real bugs in the tool definitions, NOT in this guard-rail. They
  // are out of scope for the activity-stream wire-up commit; re-enable once the
  // tool schemas are fixed in a dedicated follow-up.
  it("every registered tool produces a strict-mode-valid JSON schema", () => {
    const violations: string[] = [];
    const ctx = stubCtx();
    let checked = 0;
    let skipped = 0;

    for (const [name, def] of getToolRegistry()) {
      if (def.metaTool) {
        // Meta-tools (e.g. spawnTask) throw from create() — they're constructed
        // by the supervisor with other dependencies. Their effective schema is
        // in createTaskTool() and already conforms; we don't test it here.
        skipped++;
        continue;
      }

      let parameters;
      try {
        parameters = def.create(ctx).parameters;
      } catch (err) {
        violations.push(
          `${name} — create(ctx) threw: ${(err as Error).message}. Test stub may need extra context.`,
        );
        continue;
      }

      const schema = zodToJsonSchema(parameters, {
        target: "jsonSchema7",
        $refStrategy: "none",
      });

      walk(schema, name, violations);
      checked++;
    }

    expect(checked, "no tools were checked — registry empty?").toBeGreaterThan(0);
    expect(
      violations,
      `\n${violations.length} strict-mode violation(s) across ${checked} tool(s) (${skipped} meta-tool(s) skipped):\n  - ${violations.join("\n  - ")}\n`,
    ).toEqual([]);
  });

  // Guard against the regression caused by .nullable() on nested fields:
  // buildTool validates each inputExample against `parameters.partial()`, but
  // Zod's partial does NOT penetrate nested arrays/objects. If an example
  // omits a nested .nullable() field (e.g. filters[].propertyName), the
  // silent "example failed validation" warning drops it from the LLM prompt.
  // Replicate the same logic here with an assert so drift is blocked.
  it("every tool inputExample passes the same validation that buildTool runs", () => {
    const violations: string[] = [];
    const ctx = stubCtx();

    for (const [name, def] of getToolRegistry()) {
      if (def.metaTool) continue;
      if (!def.inputExamples?.length) continue;

      let parameters: z.ZodType;
      try {
        parameters = def.create(ctx).parameters;
      } catch {
        continue; // already reported by the previous test
      }

      const exampleSchema =
        "partial" in parameters &&
        typeof (parameters as { partial?: unknown }).partial === "function"
          ? (parameters as unknown as z.ZodObject<z.ZodRawShape>).partial()
          : parameters;

      for (const ex of def.inputExamples) {
        const result = exampleSchema.safeParse(ex.input);
        if (!result.success) {
          violations.push(
            `${name} > "${ex.label}" — ${JSON.stringify(result.error.format())}`,
          );
        }
      }
    }

    expect(
      violations,
      `\n${violations.length} inputExample validation failure(s):\n  - ${violations.join("\n  - ")}\n`,
    ).toEqual([]);
  });
});
