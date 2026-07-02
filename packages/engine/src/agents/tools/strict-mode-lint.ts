// SPDX-License-Identifier: AGPL-3.0-or-later

// OpenAI strict-mode (Responses API /v1/responses) compatibility linter for tool
// input schemas. Walks a JSON Schema and returns human-readable violations.
//
// Two consumers:
//   - strict-mode.test.ts — a build-time guard-rail over every CORE tool.
//   - the loader (registry.ts) — a load-time WARN over every PLUGIN tool, since
//     third-party plugin schemas get no engine-side check otherwise (a violation
//     would only surface as a cryptic `invalid_function_parameters` at call time).
//
// Past violations: `.url()` in http-request, `.optional()` in hubspot-contact.
// See CLAUDE.md → Important Caveats.

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

/** Return strict-mode violations for a tool input JSON Schema (empty = clean). */
export function findStrictModeViolations(schema: unknown, path: string): string[] {
  const violations: string[] = [];
  walk(schema, path, violations);
  return violations;
}
