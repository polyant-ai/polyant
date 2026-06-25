// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Structured pipeline logger for tracing request flow.
 * Logs each step with emoji prefix for easy visual scanning.
 *
 * Every method that needs instance context receives `agentId` as a parameter
 * instead of relying on module-level mutable state (which gets corrupted under
 * concurrent requests).
 */

import { randomUUID } from "crypto";
import { COLORS, shouldLog, ts as timestamp } from "./create-logger.js";

function truncate(text: string, maxLen = 80): string {
  const oneLine = text.replace(/\n/g, " ").trim();
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + "..." : oneLine;
}

function fmtInstance(agentId?: string): string {
  if (!agentId) return "";
  return `[${agentId}] `;
}

export const pipelineLog = {
  /** New request entering the pipeline. Returns a unique requestId for tracing. */
  request(channel: string, agentId: string, message: string): string {
    const requestId = randomUUID().slice(0, 8);
    if (!shouldLog("info")) return requestId;
    console.log(
      `\n${COLORS.cyan}━━━ PIPELINE [${requestId}] ━━━━━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}`
    );
    console.log(
      `${COLORS.cyan}[${timestamp()}] 📩 REQUEST [${requestId}]${COLORS.reset} channel=${channel} instance=${agentId}`
    );
    console.log(
      `${COLORS.dim}   message: "${truncate(message)}"${COLORS.reset}`
    );
    return requestId;
  },


  /** AI Gateway call */
  llmCall(agentId: string, tier: string, model: string, hasTools: boolean) {
    if (!shouldLog("debug")) return;
    console.log(
      `${COLORS.blue}[${timestamp()}] 🤖 LLM CALL${COLORS.reset} ${fmtInstance(agentId)}tier=${tier} model=${model} tools=${hasTools}`
    );
  },

  /** AI Gateway response */
  llmResponse(agentId: string, model: string, tokens: { prompt: number; completion: number }, durationMs: number, toolCallCount: number) {
    if (!shouldLog("info")) return;
    console.log(
      `${COLORS.blue}[${timestamp()}] ✅ LLM DONE${COLORS.reset} ${fmtInstance(agentId)}model=${model} tokens=${tokens.prompt}+${tokens.completion} duration=${durationMs}ms toolCalls=${toolCallCount}`
    );
  },

  /** Tool call executed */
  toolCall(agentId: string, toolName: string, args: Record<string, unknown>) {
    if (!shouldLog("debug")) return;
    const summary = Object.entries(args)
      .map(([k, v]) => {
        const val = typeof v === "string" ? truncate(v, 40) : JSON.stringify(v);
        return `${k}=${val}`;
      })
      .join(" ");
    console.log(
      `${COLORS.green}[${timestamp()}] 🔧 TOOL${COLORS.reset} ${fmtInstance(agentId)}${toolName}(${summary})`
    );
  },

  /** Tool result */
  toolResult(agentId: string, toolName: string, success: boolean, summary?: string) {
    if (!shouldLog("info")) return;
    const icon = success ? "✓" : "✗";
    const color = success ? COLORS.green : COLORS.red;
    console.log(
      `${color}[${timestamp()}]    ${icon} ${fmtInstance(agentId)}${toolName}${COLORS.reset}${summary ? ` → ${truncate(summary, 60)}` : ""}`
    );
  },

  /**
   * Concise system-prompt signal (just before LLM call): only the length, to
   * catch prompt bloat. The full prompt body is intentionally NOT logged —
   * use the per-instance `debug_enabled` flag (persists `{system, messages,
   * tools}`) or the `DEBUG_LLM_PAYLOAD` env for full-payload inspection.
   */
  systemPrompt(agentId: string, prompt: string) {
    if (!shouldLog("debug")) return;
    console.log(
      `${COLORS.yellow}[${timestamp()}] 📋 SYSTEM PROMPT${COLORS.reset} ${fmtInstance(agentId)}length=${prompt.length} chars`
    );
  },

  /** Supervisor starting */
  supervisorStart(agentId: string, toolCount: number) {
    if (!shouldLog("debug")) return;
    console.log(
      `${COLORS.magenta}[${timestamp()}] 🎯 SUPERVISOR${COLORS.reset} ${fmtInstance(agentId)}starting with ${toolCount} tools available`
    );
  },

  /** Supervisor completed */
  supervisorDone(agentId: string, durationMs: number, responsePreview: string) {
    if (!shouldLog("info")) return;
    console.log(
      `${COLORS.magenta}[${timestamp()}] 🏁 SUPERVISOR DONE${COLORS.reset} ${fmtInstance(agentId)}duration=${durationMs}ms`
    );
    console.log(
      `${COLORS.dim}   response: "${truncate(responsePreview, 500)}"${COLORS.reset}`
    );
  },

  /** Pre-enrichment context loaded */
  preEnrichment(agentId: string, hasSummary: boolean) {
    if (!shouldLog("debug")) return;
    console.log(
      `${COLORS.yellow}[${timestamp()}] 🧠 CONTEXT${COLORS.reset} ${fmtInstance(agentId)}summary=${hasSummary ? "yes" : "no"}`
    );
  },

  /** Pipeline complete */
  response(agentId: string, durationMs: number) {
    if (!shouldLog("info")) return;
    console.log(
      `${COLORS.cyan}[${timestamp()}] 📤 RESPONSE${COLORS.reset} ${fmtInstance(agentId)}total=${durationMs}ms`
    );
    console.log(
      `${COLORS.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}\n`
    );
  },
};
