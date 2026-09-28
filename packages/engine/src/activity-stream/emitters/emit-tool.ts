// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Emit a tool invocation as the `:start`/`:end` pair the activity panel folds
 * into one row (see the web's `activity-stream/merge.ts`). Called from the
 * supervisor's audit wrapper, the one place that sees every tool's real start
 * and end.
 *
 * Arguments and results go out only through the per-tool whitelist formatters,
 * which keep PII-looking keys out: the feed reaches every organization member
 * with `analytics:read`.
 */

import { randomUUID } from "node:crypto";
import type { FeedEvent } from "../activity-stream.types.js";
import { classifyResultStatus } from "../bus-emitter.js";
import { formatArgsForSpotlight, formatResultForSpotlight, summarizeArgs } from "../event-formatters.js";
import { resolveInstanceMeta, safeEmit } from "../emit-helpers.js";
import type { InstanceSlug } from "../../instances/identifiers.js";

export interface ToolStartInput {
  toolName: string;
  args: unknown;
  conversationId?: string;
  instanceSlug: InstanceSlug;
}

export type ToolOutcome = { kind: "success"; output: unknown } | { kind: "error"; message: string };

/** Emit the start event now; the returned function emits the end event. */
export function emitToolStart(input: ToolStartInput): (outcome: ToolOutcome) => void {
  const startedAt = Date.now();
  const baseId = `tool:${input.conversationId ?? "anon"}:${randomUUID()}`;
  const summary = summarizeArgs(input.toolName, input.args);
  const common = {
    persona: "agent" as const,
    text: summary || input.toolName,
    conversationId: input.conversationId,
    tool: { name: input.toolName, summary },
    argsPreview: formatArgsForSpotlight(input.toolName, input.args) || undefined,
  };
  const instance = resolveInstanceMeta(input.instanceSlug);
  const emit = (evt: FeedEvent) => {
    void instance.then((meta) => safeEmit({ ...evt, instance: meta })).catch(() => {
      /* resolveInstanceMeta swallows internally; guard the chain */
    });
  };

  emit({ ...common, id: `${baseId}:start`, ts: new Date(startedAt).toISOString() });

  return (outcome) => {
    const endedAt = Date.now();
    emit({
      ...common,
      id: `${baseId}:end`,
      ts: new Date(endedAt).toISOString(),
      status: outcome.kind === "success" ? classifyResultStatus(outcome.output) : "error",
      resultPreview: outcome.kind === "success"
        ? formatResultForSpotlight(input.toolName, outcome.output) || undefined
        : outcome.message,
      durationMs: endedAt - startedAt,
    });
  };
}
