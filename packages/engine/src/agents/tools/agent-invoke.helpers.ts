// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { asInstanceSlug } from "../../instances/identifiers.js";
import {
  emitAgentHandoffStart,
  emitAgentHandoffEnd,
} from "../../activity-stream/emitters/emit-agent-handoff.js";
import { resolveInstanceMeta } from "../../activity-stream/emit-helpers.js";

/**
 * Minimal description of the callee instance used to synthesise an
 * `ask_{slug}` tool at runtime. Lives in helpers so both the supervisor
 * wiring and unit tests share the same shape.
 */
export interface AgentTarget {
  id: string;
  slug: string;
  name: string;
  description: string | null;
}

/**
 * Dispatch payload threaded from supervisor → AgentChannelAdapter.dispatch().
 * Mirrors AgentChannelAdapter's `AgentDispatchInput` but lives here so the
 * helper module has no runtime dependency on the channel layer.
 */
export interface AgentDispatchInput {
  targetInstanceId: import("../../instances/identifiers.js").InstanceSlug;
  prompt: string;
  callerSlug: string;
  callerConversationId: string;
  parentTraceId?: string;
  depth: number;
  signal?: AbortSignal;
}

export type DispatchFn = (input: AgentDispatchInput) => Promise<string>;

export interface AgentInvokeTool {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  execute: (
    args: { prompt: string },
    opts?: { signal?: AbortSignal }
  ) => Promise<string>;
}

/**
 * Tool-name convention for an agent invocation: slug "my-helper" → "ask_my_helper".
 * Hyphens are not valid in OpenAI tool names — convert to underscores.
 */
export function toolNameForTarget(slug: string): string {
  return `ask_${slug.replace(/-/g, "_")}`;
}

/**
 * Build a synthetic tool that, when called by the LLM, forwards `prompt`
 * to the target instance via the AgentChannelAdapter. The helper handles
 * recursion bounds (max depth 1), per-call timeout, and parent-abort
 * propagation so tool errors never bubble as plain throws to the supervisor.
 */
export function buildAgentInvokeTool(opts: {
  target: AgentTarget;
  callerSlug: string;
  callerConversationId: string;
  parentTraceId?: string;
  currentDepth: number;
  timeoutMs: number;
  dispatch: DispatchFn;
}): AgentInvokeTool {
  const desc =
    opts.target.description?.trim() ||
    `Invoke the "${opts.target.name}" agent.`;
  const description =
    `Call agent "${opts.target.name}" with a free-form natural-language prompt. ` +
    `Use when: ${desc}`;

  return {
    name: toolNameForTarget(opts.target.slug),
    description,
    inputSchema: z.object({
      prompt: z
        .string()
        .min(1)
        .max(8000)
        .describe("Natural-language request to the agent"),
    }),
    execute: async ({ prompt }, runOpts) => {
      if (opts.currentDepth >= 1) {
        return "Error: nested agent invocation not allowed (max depth = 1)";
      }
      const ac = new AbortController();
      const timer = setTimeout(
        () => ac.abort(new Error("timeout")),
        opts.timeoutMs
      );
      const parentSignal = runOpts?.signal;
      const onParentAbort = () => ac.abort(parentSignal?.reason);
      parentSignal?.addEventListener("abort", onParentAbort);

      // Activity-stream handoff events — start fires before dispatch, end fires
      // when dispatch resolves (success or error). Both share `eventBaseId` so
      // the UI can group them. Meta resolution uses the TTL cache.
      const eventBaseId = `handoff:${opts.target.slug}:${randomUUID().slice(0, 8)}`;
      const handoffStart = Date.now();
      const [fromInstance, toInstance] = await Promise.all([
        resolveInstanceMeta(opts.callerSlug),
        resolveInstanceMeta(opts.target.slug),
      ]);
      const handoffMeta =
        fromInstance && toInstance
          ? {
              eventBaseId,
              fromInstance,
              toInstance,
              toolName: toolNameForTarget(opts.target.slug),
              prompt,
              callerConversationId: opts.callerConversationId,
            }
          : null;
      if (handoffMeta) {
        emitAgentHandoffStart(handoffMeta);
      }

      try {
        const text = await opts.dispatch({
          // The pipeline (and the rest of the codebase) treats `instanceId`
          // as the SLUG, not the UUID — see CLAUDE.md "Identified by
          // instanceId throughout". Pass slug here so prepareSupervisor
          // can resolve the target instance.
          targetInstanceId: asInstanceSlug(opts.target.slug),
          prompt,
          callerSlug: opts.callerSlug,
          callerConversationId: opts.callerConversationId,
          parentTraceId: opts.parentTraceId,
          depth: opts.currentDepth + 1,
          signal: ac.signal,
        });
        if (handoffMeta) {
          emitAgentHandoffEnd({
            ...handoffMeta,
            status: "success",
            durationMs: Date.now() - handoffStart,
            resultPreview: text,
          });
        }
        return text;
      } catch (err) {
        const reason = ac.signal.reason;
        const isTimeout =
          ac.signal.aborted &&
          reason instanceof Error &&
          reason.message === "timeout";
        const errorText = isTimeout
          ? `Error: agent call timed out after ${opts.timeoutMs}ms`
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
        if (handoffMeta) {
          emitAgentHandoffEnd({
            ...handoffMeta,
            status: "error",
            durationMs: Date.now() - handoffStart,
            resultPreview: errorText,
          });
        }
        return errorText;
      } finally {
        clearTimeout(timer);
        parentSignal?.removeEventListener("abort", onParentAbort);
      }
    },
  };
}
