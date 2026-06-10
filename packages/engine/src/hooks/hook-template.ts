// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Args-template renderer for hooks. Deep-walks a JSON args object and replaces
 * `{{path.to.field}}` placeholders inside STRING values with values resolved
 * from the event payload. Non-string values pass through verbatim. Missing
 * paths render as empty string and are reported in `unresolved`.
 */

import type { HookEventPayload } from "./hook-types.js";

const HOOK_TEMPLATE_RE = /\{\{([a-zA-Z0-9_.]+)\}\}/g;

export interface RenderedArgs {
  args: Record<string, unknown>;
  /** Placeholder paths that did not resolve to a value (rendered as ""). */
  unresolved: string[];
}

function resolvePathValue(obj: Record<string, unknown>, path: string): unknown {
  const segments = path.split(".");
  let current: unknown = obj;
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function renderArgsTemplate(
  args: Record<string, unknown>,
  payload: HookEventPayload,
): RenderedArgs {
  const unresolved: string[] = [];
  const source = payload as unknown as Record<string, unknown>;

  const renderString = (value: string): string =>
    value.replace(HOOK_TEMPLATE_RE, (_match, path: string) => {
      const resolved = resolvePathValue(source, path);
      if (resolved === undefined || resolved === null) {
        unresolved.push(path);
        return "";
      }
      return stringify(resolved);
    });

  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return renderString(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v)]),
      );
    }
    return value;
  };

  return { args: walk(args) as Record<string, unknown>, unresolved };
}
