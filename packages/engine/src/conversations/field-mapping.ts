// SPDX-License-Identifier: AGPL-3.0-or-later

import { MAX_STATE_BYTES, isReservedStateKey } from "./state.buffer.js";

// The reserved keys are NOT redefined here: the list lives in
// `conversations/state.buffer.ts`, the single source for every boundary that
// accepts key names from outside. A mapping that targets one of them is a
// configuration error and throws.

/**
 * Read a value from `obj` following a dot-path (e.g. `customer.phoneNumber`).
 * Returns `undefined` when any segment is missing or traverses a non-object.
 * Only own, enumerable-or-not properties are read — never inherited prototype
 * members — so `toString`/`constructor` paths do not leak engine internals.
 */
function getByDotPath(obj: unknown, path: string): unknown {
  let node: unknown = obj;
  for (const key of path.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(node, key)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/**
 * Project a caller payload onto conversation context-state keys, per a
 * per-instance `fieldMapping` (state key → payload dot-path).
 *
 * - Missing paths are omitted (a JSON payload never yields `undefined`, so an
 *   `undefined` result means "not present"); explicit `null` values are kept.
 * - Targeting a reserved key throws (caller misconfiguration).
 * - The serialized result is capped at `MAX_STATE_BYTES`, mirroring the buffer's
 *   own write guard, so a large payload cannot bloat the state row.
 */
export function extractMappedFields(
  payload: unknown,
  mapping: Record<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [stateKey, dotPath] of Object.entries(mapping)) {
    if (isReservedStateKey(stateKey)) {
      throw new Error(`field mapping: state key "${stateKey}" is reserved`);
    }
    const value = getByDotPath(payload, dotPath);
    if (value === undefined) continue;
    result[stateKey] = value;
  }

  const size = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (size > MAX_STATE_BYTES) {
    throw new Error(
      `field mapping: extracted state would exceed ${MAX_STATE_BYTES} bytes (got ${size})`,
    );
  }
  return result;
}

/** Upper bound on mapped fields per mapping: a mapping names a few identity fields, not a document. */
export const MAX_FIELD_MAPPING_ENTRIES = 50;

/**
 * Validate + normalize a field mapping written by an operator (state key →
 * payload dot-path): keys and paths trimmed, rows with an empty key dropped
 * (an editor's blank row), reserved state keys and empty path segments refused.
 * Throws an Error whose message names the problem; the caller maps it to a 400.
 */
export function normalizeFieldMapping(value: unknown, field: string): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object of state key → payload path`);
  }
  // A Map, turned into the object only at the end: `Object.fromEntries` defines
  // own properties, so no key can reach the prototype even if the reserved-key
  // check above it were ever loosened.
  const out = new Map<string, string>();
  for (const [rawKey, rawPath] of Object.entries(value)) {
    const key = rawKey.trim();
    if (!key) continue;
    if (typeof rawPath !== "string") throw new Error(`${field}.${key} must be a string path`);
    const path = rawPath.trim();
    if (isReservedStateKey(key)) throw new Error(`${field}: state key "${key}" is reserved`);
    if (key.length > 128 || path.length > 256) throw new Error(`${field}.${key} is too long`);
    if (!path || path.split(".").some((segment) => !segment)) {
      throw new Error(`${field}.${key} must be a dot-path such as "phone" or "customer.id"`);
    }
    if (out.has(key)) throw new Error(`${field}: state key "${key}" is mapped twice`);
    out.set(key, path);
  }
  if (out.size > MAX_FIELD_MAPPING_ENTRIES) {
    throw new Error(`${field} maps more than ${MAX_FIELD_MAPPING_ENTRIES} fields`);
  }
  return Object.fromEntries(out);
}
