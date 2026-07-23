// SPDX-License-Identifier: AGPL-3.0-or-later

import type { HookExecutionSummary, HookReplaceSignal, HookRegenerateSignal } from "./hook-types.js";

/** Engine safety net against a hook that always requests regenerate — NOT product logic.
 *  ponytail: constant; make per-instance only if a real case needs it. */
export const MAX_REGENERATIONS = 5;

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
  const finalText = outcome.replace?.message ?? result.text;
  return { result, finalText, outcome };
}
