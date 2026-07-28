// SPDX-License-Identifier: AGPL-3.0-or-later

import type { HookExecutionSummary, HookReplaceSignal, HookRegenerateSignal } from "./hook-types.js";
import type { CostBreakdown } from "../ai-gateway/types.js";

/** Engine safety net against a hook that always requests regenerate — NOT product logic.
 *  ponytail: constant; make per-instance only if a real case needs it. */
export const MAX_REGENERATIONS = 5;

/** Running spend total across replay passes — what pipeline_traces records for the turn. */
export interface ReplaySpend {
  llmCallMs: number;
  toolBuildingMs: number;
  promptTokens: number;
  completionTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  cost?: CostBreakdown;
}

export const EMPTY_SPEND: ReplaySpend = {
  llmCallMs: 0,
  toolBuildingMs: 0,
  promptTokens: 0,
  completionTokens: 0,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 0,
};

/**
 * Fold one supervise pass's spend into the running total (non-mutating). A replayed
 * turn runs supervise up to 6× — each pass logs to `ai_logs` independently, but
 * `pipeline_traces` gets ONE row, so it must carry the SUM (not just the delivered
 * pass) or a regenerated turn's cost/latency is silently under-reported.
 */
export function addPassSpend(
  acc: ReplaySpend,
  pass: {
    durationMs: number;
    toolBuildingMs: number;
    usage: { promptTokens: number; completionTokens: number; cachedInputTokens?: number; cacheCreationInputTokens?: number };
    cost?: CostBreakdown;
  },
): ReplaySpend {
  return {
    llmCallMs: acc.llmCallMs + pass.durationMs,
    toolBuildingMs: acc.toolBuildingMs + pass.toolBuildingMs,
    promptTokens: acc.promptTokens + pass.usage.promptTokens,
    completionTokens: acc.completionTokens + pass.usage.completionTokens,
    cachedInputTokens: acc.cachedInputTokens + (pass.usage.cachedInputTokens ?? 0),
    cacheCreationInputTokens: acc.cacheCreationInputTokens + (pass.usage.cacheCreationInputTokens ?? 0),
    cost: pass.cost
      ? acc.cost
        ? {
            input: acc.cost.input + pass.cost.input,
            cache: acc.cost.cache + pass.cost.cache,
            cacheRead: acc.cost.cacheRead + pass.cost.cacheRead,
            cacheWrite: acc.cost.cacheWrite + pass.cost.cacheWrite,
            output: acc.cost.output + pass.cost.output,
            total: acc.cost.total + pass.cost.total,
          }
        : pass.cost
      : acc.cost,
  };
}

/** Interpreted result of one round of `response_generated` hooks. */
export interface ResponseGeneratedOutcome {
  summaries: HookExecutionSummary[];
  replace?: HookReplaceSignal;
  regenerate?: HookRegenerateSignal;
}

/**
 * Generate, then let hooks evaluate the output and optionally request a replay
 * of the SAME generation (fresh supervisor turn). The stop condition is the
 * hook's (via the `regen` count passed to `evaluate`); this loop only enforces
 * `maxRegenerations` and the abort signal. `regenerate` takes precedence over
 * `replace` in a pass — the replacement is re-evaluated against the fresh output.
 */
export async function generateWithReplay<R extends { text: string }>(opts: {
  generate: (regen: number) => Promise<R>;
  evaluate: (text: string, regen: number) => Promise<ResponseGeneratedOutcome>;
  maxRegenerations: number;
  abortSignal?: AbortSignal;
}): Promise<{ result: R; finalText: string; outcome: ResponseGeneratedOutcome }> {
  const { generate, evaluate, maxRegenerations, abortSignal } = opts;
  let regen = 0;
  let result = await generate(regen);
  let outcome = await evaluate(result.text, regen);
  while (outcome.regenerate && regen < maxRegenerations && !abortSignal?.aborted) {
    regen += 1;
    result = await generate(regen);
    outcome = await evaluate(result.text, regen);
  }
  // regenerate WINS over replace: a same-pass `replace` applies only on a pass where
  // nobody asked to regenerate. When the loop exits with `regenerate` still set (cap
  // hit or aborted) we could not replay, so deliver the raw last output — never a
  // replace the contract says should have been superseded by the (denied) replay.
  const finalText = outcome.regenerate ? result.text : (outcome.replace?.message ?? result.text);
  return { result, finalText, outcome };
}
