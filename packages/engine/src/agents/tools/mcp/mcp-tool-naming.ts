// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Naming + description hygiene for tools that come from a REMOTE MCP server.
 *
 * Kept in its own dependency-free module so the supervisor prompt builder can
 * use it without importing the MCP client/store graph.
 */

/**
 * Every MCP tool is equipped under `toModelToolName("mcp:<server>:<tool>")`,
 * and `toModelToolName` maps `:` → `__` — so this is the prefix that
 * distinguishes a remote tool from a core/plugin one in the equipped map.
 */
export const MCP_MODEL_TOOL_PREFIX = "mcp__";

export function isMcpModelToolName(name: string): boolean {
  return name.startsWith(MCP_MODEL_TOOL_PREFIX);
}

/** Tag wrapping a remote description in the system prompt (see `sanitizeRemoteToolDescription`). */
export const REMOTE_TOOL_DESCRIPTION_TAG = "untrusted_remote_description";

const MAX_REMOTE_TOOL_DESCRIPTION_LENGTH = 500;

/**
 * MCP tool NAMES are already sanitized and length-capped (mcp-tools.ts), but
 * their DESCRIPTIONS are rendered verbatim into the tool catalog — i.e. into the
 * STABLE, highest-trust, cached system prefix. A third-party server therefore
 * gets to write into the system prompt. Three concrete problems, all fixed here:
 *
 * 1. Prompt injection: the description is untrusted text sitting next to the
 *    agent's own instructions. Delimiters (`<`/`>`) are neutralized so it cannot
 *    close the wrapper tag the prompt puts around it, and the caller wraps it in
 *    `<untrusted_remote_description>` so its provenance is explicit — the same
 *    semantic-tag idiom the `<context>`/`<skill>` blocks use.
 * 2. Template injection: `applyTemplate` does a plain `replaceAll("{{key}}")`
 *    reduce over the assembled sections, so a description containing
 *    `{{skills}}`/`{{memories}}` could be re-expanded. Brace pairs are defanged.
 * 3. Cache busting: a server that flaps long descriptions rewrites the shared
 *    per-instance prefix every turn (an Anthropic 1h cache WRITE costs 2x
 *    input). The length cap bounds the damage.
 *
 * Control characters are stripped and whitespace collapsed so a description can
 * neither forge section structure nor smuggle invisible instructions.
 */
export function sanitizeRemoteToolDescription(description: string): string {
  const flattened = description
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]+/g, " ")
    .replace(/[<>]/g, " ")
    .replace(/\{\{|\}\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flattened.length > MAX_REMOTE_TOOL_DESCRIPTION_LENGTH
    ? `${flattened.slice(0, MAX_REMOTE_TOOL_DESCRIPTION_LENGTH)}…`
    : flattened;
}
