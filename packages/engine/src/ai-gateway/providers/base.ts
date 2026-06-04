// SPDX-License-Identifier: AGPL-3.0-or-later

import { type LanguageModel, stepCountIs } from "ai";
import { config } from "../../config.js";
import { tracedGenerateText, tracedStreamText } from "../langsmith.js";
import type { ChatRequest, ChatResponse, ChatStreamResult, ProviderAdapter } from "../types.js";
import type { ReasoningDetail, StepDetail } from "../../conversations/schema.js";

type ModelFactory = (modelId: string, apiKeys?: ChatRequest["apiKeys"]) => LanguageModel;

const C = { reset: "\x1b[0m", cyan: "\x1b[36m", dim: "\x1b[2m" };

/**
 * Verbose dev toggle that logs the full system prompt + every message sent to
 * the provider on every call. Useful for diagnosing prompt drift in dev; a
 * **leak vector in production** (system prompts often contain customer-specific
 * data, names, contact details).
 *
 * Hard guard: forced off when `NODE_ENV === "production"`, even if the env var
 * is set. Emits a stderr warning at module load so operators see the override.
 * If you genuinely need this in prod (e.g. to debug a one-off incident on a
 * staging-like environment), set `NODE_ENV` to something other than
 * "production" for that engine pod.
 */
const DEBUG_LLM_PAYLOAD = (() => {
  const requested = process.env.DEBUG_LLM_PAYLOAD === "1";
  if (!requested) return false;
  if (process.env.NODE_ENV === "production") {
    // eslint-disable-next-line no-console -- intentional startup warning to stderr
    console.warn(
      "[ai-gateway] DEBUG_LLM_PAYLOAD=1 is set but NODE_ENV=production — " +
        "ignoring (verbose prompt logging would leak customer data via stdout). " +
        "Unset NODE_ENV or change it from 'production' to re-enable.",
    );
    return false;
  }
  return true;
})();

function logLlmPayload(providerName: string, modelId: string, request: ChatRequest) {
  if (!DEBUG_LLM_PAYLOAD) return;

  const ts = new Date().toLocaleTimeString(config.datetime.locale, { hour12: false });
  const sys = request.system ?? "";
  const toolNames = request.tools ? Object.keys(request.tools) : [];

  console.log(
    `${C.cyan}[${ts}] 🔍 LLM REQUEST PAYLOAD [${providerName}/${modelId}]${C.reset}`
  );
  console.log(`${C.dim}${JSON.stringify({
    systemPromptLength: sys.length,
    systemPrompt: sys,
    messageCount: request.messages.length,
    messages: request.messages.map(m => ({
      role: m.role,
      content: typeof m.content === "string"
        ? m.content.slice(0, 200) + (m.content.length > 200 ? "..." : "")
        : `[${Array.isArray(m.content) ? m.content.length + " parts" : typeof m.content}]`,
    })),
    tools: toolNames,
    toolCount: toolNames.length,
    maxSteps: request.maxSteps ?? 1,
  }, null, 2)}${C.reset}`);
}

/** Safely coerce a token count to a non-negative integer. Handles NaN, undefined, null. */
const safeTokens = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
};

/** Aggregate usage from individual steps when the top-level usage is NaN.
 *  AI SDK's streamText with maxSteps only captures the last step's usage,
 *  not the sum across all steps. */
function aggregateStepUsage(
  steps: { usage?: { promptTokens?: number; completionTokens?: number } }[],
): { promptTokens: number; completionTokens: number } {
  let prompt = 0;
  let completion = 0;
  for (const step of steps) {
    if (step.usage) {
      prompt += safeTokens(step.usage.promptTokens);
      completion += safeTokens(step.usage.completionTokens);
    }
  }
  return { promptTokens: prompt, completionTokens: completion };
}

/** Compute token usage, falling back to step-level aggregation when top-level is unavailable. */
function buildUsage(
  topLevelUsage: { promptTokens?: number; completionTokens?: number },
  steps: { usage?: { promptTokens?: number; completionTokens?: number } }[],
): { promptTokens: number; completionTokens: number } {
  let prompt = safeTokens(topLevelUsage.promptTokens);
  let completion = safeTokens(topLevelUsage.completionTokens);

  if (prompt === 0 && completion === 0 && steps.length > 0) {
    ({ promptTokens: prompt, completionTokens: completion } = aggregateStepUsage(steps));
  }

  return { promptTokens: prompt, completionTokens: completion };
}

/**
 * Shape of a Vercel AI SDK v4 step result we consume. Documented at
 * https://ai-sdk.dev — fields we use:
 *  - text                  assistant text emitted in this step
 *  - stepType              "initial" | "continue" | "tool-result"
 *  - toolCalls             array of {toolCallId, toolName, args}
 *  - toolResults           array of {toolCallId, result}
 *  - reasoningDetails      array of ReasoningDetail (text/redacted, signature for Anthropic)
 *  - finishReason          stop | length | tool-calls | …
 *  - usage                 {promptTokens, completionTokens}
 */
interface SdkStep {
  text?: string;
  stepType?: string;
  toolCalls?: { toolCallId: string; toolName: string; args: unknown }[];
  toolResults?: { toolCallId: string; result: unknown }[];
  reasoningDetails?: unknown[];
  finishReason?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

/**
 * AI SDK v5+ renamed several step/usage fields. We keep our internal SdkStep
 * shape (args/result/promptTokens/completionTokens) stable and translate from
 * the SDK shape here, so downstream logic (buildSteps, buildUsage) is untouched.
 *  - toolCall.args      → toolCall.input
 *  - toolResult.result  → toolResult.output
 *  - usage {promptTokens,completionTokens} → {inputTokens,outputTokens}
 *  - step.reasoningDetails / result.reasoningDetails → reasoning (array)
 */
function mapUsage(u: unknown): { promptTokens?: number; completionTokens?: number } {
  if (!u || typeof u !== "object") return {};
  const o = u as Record<string, unknown>;
  return {
    promptTokens: typeof o.inputTokens === "number" ? o.inputTokens : undefined,
    completionTokens: typeof o.outputTokens === "number" ? o.outputTokens : undefined,
  };
}

function normalizeSdkSteps(rawSteps: unknown): SdkStep[] {
  if (!Array.isArray(rawSteps)) return [];
  return rawSteps.map((raw): SdkStep => {
    const s = (raw ?? {}) as Record<string, unknown>;
    const toolCalls = Array.isArray(s.toolCalls)
      ? (s.toolCalls as Record<string, unknown>[]).map((tc) => ({
          toolCallId: String(tc.toolCallId ?? ""),
          toolName: String(tc.toolName ?? ""),
          args: tc.input,
        }))
      : undefined;
    const toolResults = Array.isArray(s.toolResults)
      ? (s.toolResults as Record<string, unknown>[]).map((tr) => ({
          toolCallId: String(tr.toolCallId ?? ""),
          result: tr.output,
        }))
      : undefined;
    return {
      text: typeof s.text === "string" ? s.text : undefined,
      stepType: typeof s.stepType === "string" ? s.stepType : undefined,
      toolCalls,
      toolResults,
      reasoningDetails: Array.isArray(s.reasoning) ? s.reasoning : undefined,
      finishReason: typeof s.finishReason === "string" ? s.finishReason : undefined,
      usage: mapUsage(s.usage),
    };
  });
}

/** Coerce SDK reasoningDetails (loosely typed `unknown[]`) into our ReasoningDetail[] shape. */
function normaliseReasoningDetails(details: unknown[] | undefined): ReasoningDetail[] | undefined {
  if (!details || details.length === 0) return undefined;

  const out: ReasoningDetail[] = [];
  for (const d of details) {
    if (!d || typeof d !== "object") continue;
    const obj = d as Record<string, unknown>;
    if (obj.type === "text" && typeof obj.text === "string") {
      const sig = typeof obj.signature === "string" ? obj.signature : undefined;
      out.push({ type: "text", text: obj.text, ...(sig ? { signature: sig } : {}) });
    } else if (obj.type === "redacted" && typeof obj.data === "string") {
      out.push({ type: "redacted", data: obj.data });
    }
    // Unknown types silently dropped — they cannot be re-injected anyway.
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Map AI SDK step results into our persisted StepDetail[] shape.
 *
 * Each step becomes one StepDetail with index, stepType, text, toolCalls,
 * toolResults, reasoning (per-step), finishReason, usage and durationMs.
 *
 * `durationMs` is approximated by distributing the total wall-clock duration
 * proportionally across steps (the SDK does not expose per-step timing in
 * v4); for single-step responses this collapses to the full duration.
 */
export function buildSteps(steps: SdkStep[], totalDurationMs: number): StepDetail[] {
  if (steps.length === 0) return [];
  const perStepDuration = Math.max(0, Math.floor(totalDurationMs / steps.length));

  return steps.map((s, i) => {
    const reasoning = normaliseReasoningDetails(s.reasoningDetails);
    const detail: StepDetail = {
      index: i,
      stepType: (s.stepType as StepDetail["stepType"]) ?? "initial",
      text: s.text ?? "",
      toolCalls: (s.toolCalls ?? []).map((tc) => ({
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.args as Record<string, unknown>,
      })),
      finishReason: s.finishReason ?? "stop",
      durationMs: perStepDuration,
    };
    if (s.toolResults && s.toolResults.length > 0) {
      detail.toolResults = s.toolResults.map((tr) => ({
        toolCallId: tr.toolCallId,
        result: tr.result,
      }));
    }
    if (reasoning) detail.reasoning = reasoning;
    if (s.usage?.promptTokens !== undefined) detail.promptTokens = safeTokens(s.usage.promptTokens);
    if (s.usage?.completionTokens !== undefined) detail.completionTokens = safeTokens(s.usage.completionTokens);
    return detail;
  });
}

/** Aggregate reasoning at message level by concatenating per-step reasoning details in order. */
export function aggregateReasoning(steps: StepDetail[]): ReasoningDetail[] | undefined {
  const out: ReasoningDetail[] = [];
  for (const step of steps) {
    if (step.reasoning) out.push(...step.reasoning);
  }
  return out.length > 0 ? out : undefined;
}

/** Build the final ChatResponse payload from resolved LLM result data. */
function buildChatResponse(
  text: string,
  rawSteps: SdkStep[],
  topLevelReasoning: unknown[] | undefined,
  usage: { promptTokens?: number; completionTokens?: number },
  durationMs: number,
  modelId: string,
  providerName: string,
): ChatResponse {
  const steps = buildSteps(rawSteps, durationMs);
  const { promptTokens, completionTokens } = buildUsage(usage, rawSteps);

  // Prefer the SDK's top-level reasoningDetails when available (it already has
  // the canonical signed blocks for Anthropic). Fallback to per-step aggregation.
  const reasoning =
    normaliseReasoningDetails(topLevelReasoning) ?? aggregateReasoning(steps);

  return {
    text,
    steps,
    ...(reasoning ? { reasoning } : {}),
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    },
    durationMs,
    model: modelId,
    provider: providerName,
  };
}

export function createProvider(providerName: string, createModel: ModelFactory): ProviderAdapter {
  return {
    name: providerName,

    async chat(request: ChatRequest, modelId: string): Promise<ChatResponse> {
      const start = Date.now();

      logLlmPayload(providerName, modelId, request);

      const result = await tracedGenerateText({
        model: createModel(modelId, request.apiKeys),
        system: request.system,
        messages: request.messages,
        tools: request.tools,
        stopWhen: stepCountIs(request.maxSteps ?? 1),
        abortSignal: request.abortSignal,
        ...(request.providerOptions ? { providerOptions: request.providerOptions as Record<string, Record<string, never>> } : {}),
      });

      // v5+: per-turn reasoning blocks are exposed at the top level as `reasoning`
      // (array). Normalised for type safety.
      const topReasoning = (result as unknown as { reasoning?: unknown[] }).reasoning;

      return buildChatResponse(
        result.text,
        normalizeSdkSteps((result as unknown as { steps?: unknown }).steps),
        topReasoning,
        // v5+: `usage` is the final step only; `totalUsage` is the cross-step total.
        mapUsage((result as unknown as { totalUsage?: unknown }).totalUsage),
        Date.now() - start,
        modelId,
        providerName,
      );
    },

    async chatStream(request: ChatRequest, modelId: string): Promise<ChatStreamResult> {
      const start = Date.now();

      logLlmPayload(providerName, modelId, request);

      // wrapAISDK wraps streamText in traceable, making it return a Promise.
      // The await resolves immediately (before streaming completes) because
      // tracing happens at the model middleware level, not the streamText level.
      const result = await tracedStreamText({
        model: createModel(modelId, request.apiKeys),
        system: request.system,
        messages: request.messages,
        tools: request.tools,
        stopWhen: stepCountIs(request.maxSteps ?? 1),
        abortSignal: request.abortSignal,
        ...(request.providerOptions ? { providerOptions: request.providerOptions as Record<string, Record<string, never>> } : {}),
      });

      return {
        textStream: result.textStream,
        fullStream: result.fullStream,
        response: (async () => {
          const finalText = await result.text;
          // v5+: totalUsage is the cross-step total (usage = final step only).
          const finalUsage = await (result as unknown as { totalUsage?: Promise<unknown> }).totalUsage;
          const steps = await result.steps;
          // v5+: per-turn reasoning blocks live on `reasoning` (Promise<array>).
          const topReasoning = await (result as unknown as { reasoning?: Promise<unknown[]> }).reasoning;
          return buildChatResponse(
            finalText,
            normalizeSdkSteps(steps),
            topReasoning,
            mapUsage(finalUsage),
            Date.now() - start,
            modelId,
            providerName,
          );
        })(),
      };
    },
  };
}
