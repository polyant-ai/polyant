// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What one gateway call records for the request path, beyond its usage: when
 * each step and each tool run started, and, while the agent's debug flag is on,
 * every request sent to the provider with what came back.
 */

/** One request to the provider: a step of the call, or a retry of it. */
export interface ModelExchange {
  stepIndex: number;
  attempt: number;
  /** HTTP status of the answer; null when none came back (network failure, abort). */
  status: number | null;
  request: unknown;
  response: unknown;
}

/** Start time (epoch ms) of each step, and start and duration of each tool run by call id. */
export interface CallTimeline {
  stepStarts: number[];
  toolRuns: Map<string, { startedAt: number; durationMs?: number }>;
}

export function callTimeline(): CallTimeline & {
  onStepStart(event: { stepNumber: number }): void;
  onToolExecutionStart(event: { toolCall: { toolCallId: string } }): void;
  onToolExecutionEnd(event: { toolCall: { toolCallId: string }; toolExecutionMs: number }): void;
} {
  const stepStarts: number[] = [];
  const toolRuns = new Map<string, { startedAt: number; durationMs?: number }>();
  return {
    stepStarts,
    toolRuns,
    onStepStart: ({ stepNumber }) => {
      stepStarts[stepNumber] = Date.now();
    },
    onToolExecutionStart: ({ toolCall }) => {
      toolRuns.set(toolCall.toolCallId, { startedAt: Date.now() });
    },
    onToolExecutionEnd: ({ toolCall, toolExecutionMs }) => {
      const run = toolRuns.get(toolCall.toolCallId);
      if (run) run.durationMs = Math.round(toolExecutionMs);
    },
  };
}

/** A body the provider adapter kept as JSON text, parsed; anything else as it is. */
function parsedBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

const EXCHANGES = Symbol("modelExchanges");

/**
 * Records each request the model middleware sees. A request after a failed one
 * is a retry of the same step (the SDK retries inside a step); any other starts
 * the next step.
 */
export function exchangeRecorder() {
  const list: ModelExchange[] = [];
  let step = -1;
  let attempt = 0;
  let current: ModelExchange | undefined;
  return {
    list,
    begin(retry: boolean, params: { prompt: unknown; tools?: unknown }): void {
      if (retry && step >= 0) attempt++;
      else {
        step++;
        attempt = 1;
      }
      // The provider-level prompt stands in until the adapter reports the body it sent.
      current = { stepIndex: step, attempt, status: null, request: { prompt: params.prompt, tools: params.tools }, response: null };
      list.push(current);
    },
    answered(result: unknown): void {
      if (!current) return;
      const r = (result ?? {}) as { request?: { body?: unknown }; response?: { body?: unknown } };
      if (r.request?.body !== undefined) current.request = parsedBody(r.request.body);
      current.status = 200;
      if (r.response?.body !== undefined) current.response = parsedBody(r.response.body);
    },
    failed(err: unknown): void {
      if (!current) return;
      const e = (err ?? {}) as { statusCode?: number; requestBodyValues?: unknown; responseBody?: unknown; name?: string; message?: string };
      if (e.requestBodyValues !== undefined) current.request = e.requestBodyValues;
      current.status = typeof e.statusCode === "number" ? e.statusCode : null;
      current.response =
        e.responseBody !== undefined ? parsedBody(e.responseBody) : { error: e.name ?? "Error" };
    },
    /**
     * A streamed request leaves no response body: fill each answered step with
     * what the SDK assembled from the stream.
     */
    fillFromSteps(steps: unknown): void {
      if (!Array.isArray(steps)) return;
      for (const ex of list) {
        if (ex.response !== null || ex.status !== 200) continue;
        const s = (steps[ex.stepIndex] ?? {}) as { content?: unknown; finishReason?: unknown; usage?: unknown };
        ex.response = { assembled: true, content: s.content, finishReason: s.finishReason, usage: s.usage };
      }
    },
    pinTo(err: unknown): void {
      if (err && typeof err === "object") (err as Record<symbol, unknown>)[EXCHANGES] = list;
    },
  };
}

export type ExchangeRecorder = ReturnType<typeof exchangeRecorder>;

/** The exchanges a failed call made before it failed, when they were recorded. */
export function exchangesOf(err: unknown): ModelExchange[] | undefined {
  if (!err || typeof err !== "object") return undefined;
  return (err as Record<symbol, unknown>)[EXCHANGES] as ModelExchange[] | undefined;
}
