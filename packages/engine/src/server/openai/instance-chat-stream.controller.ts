// SPDX-License-Identifier: AGPL-3.0-or-later

import { Body, Controller, Inject, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { OpenAIService } from "./openai.service.js";
import { Public } from "../../auth/decorators/public.decorator.js";
import { validateInstanceApiKey } from "./instance-api-key-auth.js";
import type { ChatCompletionRequest } from "./openai.types.js";

/**
 * Keep-alive cadence for the SSE stream. Long, output-less tool calls (e.g.
 * `claudeCode` cloning + analysing a repo for minutes) emit no stream parts, so
 * without a periodic byte an idle timeout on the browser/proxy would sever the
 * connection and the client would miss the final `done`. An SSE comment line
 * (starting with ":") keeps it warm and is ignored by the stream parser. Matches
 * the activity-stream heartbeat so both long-lived SSE endpoints stay warm below
 * the typical 30–60s proxy idle cut-off.
 */
const HEARTBEAT_MS = 25_000;

/**
 * Stream parts that mean the turn has produced something: from the first of
 * them a client disconnect no longer aborts the pipeline. `tool-input-start`
 * comes as soon as the model begins writing a tool call, before the tool runs.
 */
const OUTPUT_PARTS = new Set([
  "text-delta", "reasoning-delta", "tool-input-start", "tool-call", "tool-result",
]);

/**
 * Native streaming endpoint for the admin playground (and other first-party UIs).
 *
 * Unlike `/v1/chat/completions` (OpenAI-compatible), this endpoint emits a
 * **typed SSE stream** that exposes the full multi-step + reasoning timeline
 * as it happens:
 *
 *   event: hook-execution     data: {"hookId":"…","event":"…","toolName":"…","success":true,"durationMs":42}
 *   event: step-start         data: {"index":0,"stepType":"initial"}
 *   event: reasoning-delta    data: {"text":"…"}
 *   event: tool-call          data: {"id":"…","name":"…","args":{…}}
 *   event: tool-result        data: {"id":"…","result":…}
 *   event: text-delta         data: {"text":"…"}
 *   event: step-finish        data: {"index":0,"finishReason":"stop"}
 *   event: done               data: {}
 *   event: error              data: {"message":"…"}
 *
 * `hook-execution` events fire in two waves: pre-LLM hooks (conversation_start,
 * message_received) right after the stream opens, and post-LLM hooks
 * (response_generated, response_sent) after the text finishes, before `done`
 * (which therefore waits for the synchronous post-processing phase).
 *
 * The endpoint accepts the same `ChatCompletionRequest` body as the OpenAI
 * endpoint (model = instance slug, messages, optional `chat_id`) so that the
 * playground can reuse its existing request shape.
 */
@Controller("api/instances")
export class InstanceChatStreamController {
  constructor(@Inject(OpenAIService) private readonly openaiService: OpenAIService) {}

  @Public()
  @Post(":slug/chat/stream")
  async stream(
    @Param("slug") slug: string,
    @Body() body: ChatCompletionRequest,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // A client that disconnects aborts the pipeline itself only while the turn
    // has produced nothing: an aborted turn is not persisted, and once the model
    // has written text, reasoned or begun a tool call (which may write), the
    // turn runs to its end and is saved, so its record never goes missing. After
    // that the disconnect only stops the relay.
    //
    // The RESPONSE's `close` is the disconnect signal, registered before the
    // first await. The request's `close` is not: since Node 16 it fires as soon
    // as the body has been read — by the body parser, before this handler — with
    // the client still connected. `writableFinished` tells our own `res.end()`
    // apart from a client that went away.
    const abortController = new AbortController();
    let produced = false;
    let clientGone = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined = undefined;
    res.on("close", () => {
      if (res.writableFinished) return;
      clearInterval(heartbeat);
      clientGone = true;
      if (!produced && !abortController.signal.aborted) abortController.abort();
    });

    // Per-instance API key auth (mirrors /v1/chat/completions). The global
    // JWT AuthGuard is skipped via @Public() — this route accepts the same
    // Bearer-token shape as the OpenAI-compatible endpoint, NOT a session
    // cookie. See instance-api-key-auth.ts for the rules.
    // A web turn: on an agent that maps call context it needs the agent's key
    // even when the agent is otherwise open (see WebTurn).
    await validateInstanceApiKey(slug, req.headers["authorization"] as string | undefined,
      { carriesContext: body.context !== undefined && body.context !== null });

    // Force the model field to the URL slug — the playground already passes
    // it but we ignore any client-side override to keep the route authoritative.
    const request: ChatCompletionRequest = { ...body, model: slug, stream: true };

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    // Disable the socket idle-timeout: a single long tool call can run for
    // minutes with no token output, and Node's default socket timeout would
    // otherwise tear down this long-lived response.
    res.setTimeout(0);

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Keep the connection warm during output-less stretches (see HEARTBEAT_MS).
    heartbeat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        // Socket already gone; the close handler / finally will clear this.
      }
    }, HEARTBEAT_MS);

    let stream;
    try {
      stream = await this.openaiService.chatCompletionStream(request, abortController.signal);
    } catch (err) {
      const message = err instanceof Error ? err.message : "stream initialisation failed";
      clearInterval(heartbeat);
      send("error", { message });
      send("done", {});
      res.end();
      return;
    }

    // Pre-LLM hook outcomes (conversation_start / message_received) — already
    // executed by the time the stream exists; surface them before the LLM events.
    for (const exec of stream.hookExecutions ?? []) {
      send("hook-execution", exec);
    }

    // Track open steps so we can emit step-start exactly once per step.
    let currentStep = -1;

    const ensureStepStarted = (index: number, stepType: string) => {
      if (index !== currentStep) {
        currentStep = index;
        send("step-start", { index, stepType });
      }
    };

    try {
      // AI SDK v6 `fullStream` parts (TextStreamPart). v5+ renamed both the
      // lifecycle events (step-start→start-step, step-finish→finish-step,
      // reasoning→reasoning-delta) and the payload fields
      // (textDelta→text, args→input, result→output). The outbound SSE protocol
      // below is unchanged so the playground frontend keeps working.
      for await (const event of stream.fullStream as AsyncIterable<{
        type: string;
        text?: string;
        toolName?: string;
        toolCallId?: string;
        input?: unknown;
        output?: unknown;
        finishReason?: string;
        error?: unknown;
      }>) {
        if (clientGone) break;
        if (OUTPUT_PARTS.has(event.type)) produced = true;

        switch (event.type) {
          case "start-step": {
            currentStep = currentStep + 1;
            send("step-start", { index: currentStep, stepType: "initial" });
            break;
          }
          case "reasoning-delta":
            if (event.text) send("reasoning-delta", { text: event.text });
            break;
          case "tool-call":
            if (event.toolCallId && event.toolName) {
              ensureStepStarted(Math.max(0, currentStep), "tool-result");
              send("tool-call", {
                id: event.toolCallId,
                name: event.toolName,
                args: event.input ?? {},
              });
            }
            break;
          case "tool-result":
            if (event.toolCallId) {
              send("tool-result", { id: event.toolCallId, result: event.output ?? null });
            }
            break;
          case "text-delta":
            if (event.text) {
              ensureStepStarted(Math.max(0, currentStep), "continue");
              send("text-delta", { text: event.text });
            }
            break;
          case "finish-step":
            send("step-finish", {
              index: Math.max(0, currentStep),
              finishReason: event.finishReason ?? "stop",
            });
            break;
          case "error": {
            const detail = event.error instanceof Error
              ? event.error.message
              : String(event.error ?? "Unknown error");
            send("error", { message: detail });
            break;
          }
          default:
            // Other v6 parts (text-start/-end, reasoning-start/-end,
            // tool-input-*, start, finish, raw, source, file) are not surfaced —
            // the playground only needs the canonical lifecycle above.
            break;
        }
      }
      // Post-processing runs the response_generated/response_sent hooks — await
      // it so their outcomes reach the client before `done`. Hooks are
      // synchronous by design; on abort the post phase short-circuits.
      try {
        const result = await stream.completed;
        for (const exec of result.hookExecutions ?? []) {
          send("hook-execution", exec);
        }
      } catch (err) {
        console.error("[chat/stream] post-process error:", err);
      }
      // Echo the persisted conversation + assistant message ids so the client can
      // later fetch the per-message debug payload without ordinal-matching.
      send("done", stream.meta ?? {});
    } catch (err) {
      const message = err instanceof Error ? err.message : "stream error";
      send("error", { message });
    } finally {
      clearInterval(heartbeat);
      res.end();
      // Safety net: if the loop threw before `completed` was awaited, swallow
      // its eventual rejection so it never surfaces as an unhandled rejection.
      stream.completed.catch(() => {});
    }
  }
}
