// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Lightweight template renderer for webhook payload injection.
 *
 * Supported patterns:
 *   {{payload}}              — full JSON-stringified payload (pretty-printed)
 *   {{payload.field}}        — top-level field value
 *   {{payload.a.b.c}}        — deep nested field access
 *
 * Missing fields resolve to an empty string.
 */

const TEMPLATE_RE = /\{\{payload(?:\.([a-zA-Z0-9_.]+))?\}\}/g;

function resolvePathValue(
  obj: Record<string, unknown>,
  path: string,
): unknown {
  const segments = path.split('.');
  let current: unknown = obj;

  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

/**
 * `transform` is applied to every SUBSTITUTED value, never to the template.
 *
 * That split is the point. The template is written by an operator and is
 * trusted; the values come from whoever POSTed the webhook and are not. A caller
 * that puts the result into a prompt uses this to fence the outside text, so the
 * model can see where the operator's instruction ends — without the operator's
 * own words being labelled untrusted.
 */
export interface RenderOptions {
  transform?: (value: string) => string;
}

export function renderTemplate(
  template: string,
  payload: Record<string, unknown>,
  opts?: RenderOptions,
): string {
  const transform = opts?.transform ?? ((v: string) => v);
  return template.replace(TEMPLATE_RE, (_match, path: string | undefined) => {
    // {{payload}} — full payload
    if (path === undefined) {
      return transform(JSON.stringify(payload, null, 2));
    }

    // {{payload.some.path}} — resolve nested value
    const value = resolvePathValue(payload, path);
    return transform(stringify(value));
  });
}
