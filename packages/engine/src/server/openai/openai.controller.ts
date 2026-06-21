// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Controller,
  Post,
  Get,
  Body,
  Res,
  HttpCode,
  Headers,
  Inject,
  BadRequestException,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { randomUUID } from "crypto";
import { z } from "zod";
import { OpenAIService } from "./openai.service.js";
import { Public } from "../../auth/decorators/public.decorator.js";
import { AllowInstanceApiKey } from "../../auth/decorators/allow-instance-api-key.decorator.js";
import { validateInstanceApiKey } from "./instance-api-key-auth.js";
import { RequirePermission, Permission } from "../../authz/index.js";
import type {
  ChatCompletionRequest,
  ChatCompletionChunk,
  ModelsListResponse,
} from "./openai.types.js";

// Restrict model to the instance-slug shape — same pattern as agents.controller.ts.
// This is the only user-controlled value that we echo back into the SSE stream
// (role chunk, finish chunk, every text/think chunk) so it MUST be a safe identifier
// to neutralise reflected-XSS taint.
const MODEL_SLUG_RE = /^[a-z0-9]([a-z0-9_.-]*[a-z0-9])?$/;

const chatCompletionSchema = z.object({
  model: z
    .string()
    .min(1)
    .max(128)
    .regex(MODEL_SLUG_RE, "model must be a lowercase slug (a-z, 0-9, _, ., -)"),
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string(),
  })).min(1).max(100),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  chat_id: z.string().max(128).optional(),
}).passthrough();

@Controller("v1")
export class OpenAIController {
  constructor(
    @Inject(OpenAIService) private readonly openaiService: OpenAIService,
  ) {}

  @AllowInstanceApiKey()
  @RequirePermission(Permission.AGENT_READ)
  @Get("models")
  async listModels(): Promise<ModelsListResponse> {
    const agents = await this.openaiService.listInstances();
    return {
      object: "list",
      data: agents.map((inst) => ({
        id: inst.slug,
        object: "model" as const,
        created: Math.floor(Date.now() / 1000),
        owned_by: "polyant",
      })),
    };
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post("chat/completions")
  @HttpCode(200)
  async chatCompletions(
    @Body() body: ChatCompletionRequest,
    @Res() res: Response,
    @Headers("authorization") authHeader?: string,
  ) {
    const parsed = chatCompletionSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join("; "));
    }
    // Use the Zod-validated model going forward — guarantees the slug regex.
    body.model = parsed.data.model;

    await this.validateAuth(body.model, authHeader);

    if (body.stream) {
      return this.handleStreaming(body, res);
    }

    const result = await this.openaiService.chatCompletion(body);
    res.json(result);
  }

  private async handleStreaming(body: ChatCompletionRequest, res: Response) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    // Defence-in-depth against reflected-XSS: prevent the response from being
    // sniffed and rendered as HTML by an off-spec client.
    res.setHeader("X-Content-Type-Options", "nosniff");

    const completionId = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const created = Math.floor(Date.now() / 1000);

    // Send role chunk
    const roleChunk: ChatCompletionChunk = {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model: body.model,
      choices: [
        { index: 0, delta: { role: "assistant" }, finish_reason: null },
      ],
    };
    res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

    // Get real streaming response from the pipeline
    const stream = await this.openaiService.chatCompletionStream(body);

    // Pipe fullStream events: tool calls wrapped in <think> tags, text deltas as standard chunks
    let thinkOpen = false;

    let chunkCount = 0;
    try {
      for await (const event of stream.fullStream as AsyncIterable<{ type: string; text?: string; toolName?: string; error?: unknown }>) {
        chunkCount++;
        if (event.type === "error") {
          const errDetail = event.error instanceof Error ? event.error.message : String(event.error ?? "Unknown error");
          console.error(`[SSE] LLM stream error event:`, errDetail);
          res.write(`data: ${JSON.stringify(this.makeChunk(completionId, created, body.model, `⚠️ ${errDetail}`))}\n\n`);
          continue;
        }
        if (event.type === "tool-call" && event.toolName) {
          if (!thinkOpen) {
            res.write(`data: ${JSON.stringify(this.makeChunk(completionId, created, body.model, "<think>\n"))}\n\n`);
            thinkOpen = true;
          }
          res.write(`data: ${JSON.stringify(this.makeChunk(completionId, created, body.model, `⏳ ${event.toolName}...\n`))}\n\n`);
        } else if (event.type === "tool-result" && event.toolName) {
          if (thinkOpen) {
            res.write(`data: ${JSON.stringify(this.makeChunk(completionId, created, body.model, `✓ ${event.toolName}\n`))}\n\n`);
          }
        } else if (event.type === "text-delta" && event.text) {
          if (thinkOpen) {
            res.write(`data: ${JSON.stringify(this.makeChunk(completionId, created, body.model, "</think>\n"))}\n\n`);
            thinkOpen = false;
          }
          res.write(`data: ${JSON.stringify(this.makeChunk(completionId, created, body.model, event.text))}\n\n`);
        }
      }
    } catch (err) {
      console.error(`[SSE] stream error after ${chunkCount} chunks:`, err);
      const errorMsg = "An error occurred while generating the response.";
      res.write(`data: ${JSON.stringify(this.makeChunk(completionId, created, body.model, errorMsg))}\n\n`);
    }

    // Safety: close think block if still open (e.g. no text response after tools)
    if (thinkOpen) {
      res.write(`data: ${JSON.stringify(this.makeChunk(completionId, created, body.model, "</think>\n"))}\n\n`);
    }

    // Send finish chunk + [DONE] sentinel so clients never hang
    const finishChunk: ChatCompletionChunk = {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
    res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();

    // Await completion to trigger post-processor (fire-and-forget side effect)
    stream.completed.catch((err) => console.error("[SSE] Stream completion error:", err));
  }

  private makeChunk(id: string, created: number, model: string, content: string): ChatCompletionChunk {
    return {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    };
  }

  private async validateAuth(instanceSlug: string, authHeader?: string) {
    return validateInstanceApiKey(instanceSlug, authHeader);
  }
}
