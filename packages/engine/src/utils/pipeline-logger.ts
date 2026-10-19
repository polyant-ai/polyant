// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Structured pipeline logger for tracing request flow.
 * Logs each step with emoji prefix for easy visual scanning.
 *
 * Every method that needs instance context receives `instanceId` as a parameter
 * instead of relying on module-level mutable state (which gets corrupted under
 * concurrent requests).
 */

import { randomUUID } from "crypto";
import { COLORS, sanitizeForLog, shouldLog, ts as timestamp } from "./create-logger.js";

function truncate(text: string, maxLen = 80): string {
  const oneLine = text.replace(/\n/g, " ").trim();
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + "..." : oneLine;
}

function fmtInstance(instanceId?: string): string {
  if (!instanceId) return "";
  // The slug reaches here from request paths and channel payloads — strip control
  // chars so it cannot forge a log line. Sibling helpers get this from truncate().
  return `[${sanitizeForLog(instanceId)}] `;
}

type Color = (typeof COLORS)[keyof typeof COLORS];

/**
 * One log line: `[time] <label> [instance] body`. The level guard lives here so a
 * disabled level never formats its body (pass a function for a body that costs).
 */
function line(
  level: "debug" | "info",
  color: Color,
  label: string,
  instanceId: string,
  body: string | (() => string),
): void {
  if (!shouldLog(level)) return;
  const text = typeof body === "function" ? body() : body;
  console.log(`${color}[${timestamp()}] ${label}${COLORS.reset} ${fmtInstance(instanceId)}${text}`);
}

export const pipelineLog = {
  /** New request entering the pipeline. Returns a unique requestId for tracing. */
  request(channel: string, instanceId: string, message: string): string {
    const requestId = randomUUID().slice(0, 8);
    if (!shouldLog("info")) return requestId;
    console.log(
      `\n${COLORS.cyan}━━━ PIPELINE [${requestId}] ━━━━━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}`
    );
    console.log(
      `${COLORS.cyan}[${timestamp()}] 📩 REQUEST [${requestId}]${COLORS.reset} channel=${channel} instance=${instanceId}`
    );
    // Message text is user content: debug only, and formatted only when emitted.
    if (shouldLog("debug")) {
      console.log(
        `${COLORS.dim}   message: "${truncate(message)}"${COLORS.reset}`
      );
    }
    return requestId;
  },


  /** AI Gateway call */
  llmCall(instanceId: string, tier: string, model: string, hasTools: boolean) {
    line("debug", COLORS.blue, "🤖 LLM CALL", instanceId, `tier=${tier} model=${model} tools=${hasTools}`);
  },

  /** AI Gateway response */
  llmResponse(instanceId: string, model: string, tokens: { prompt: number; completion: number }, durationMs: number, toolCallCount: number) {
    line(
      "info",
      COLORS.blue,
      "✅ LLM DONE",
      instanceId,
      `model=${model} tokens=${tokens.prompt}+${tokens.completion} duration=${durationMs}ms toolCalls=${toolCallCount}`,
    );
  },

  /** Tool call executed */
  toolCall(instanceId: string, toolName: string, args: Record<string, unknown>) {
    line("debug", COLORS.green, "🔧 TOOL", instanceId, () => {
      const summary = Object.entries(args)
        .map(([k, v]) => {
          const val = typeof v === "string" ? truncate(v, 40) : JSON.stringify(v);
          return `${k}=${val}`;
        })
        .join(" ");
      return `${toolName}(${summary})`;
    });
  },

  /** Tool result */
  toolResult(instanceId: string, toolName: string, success: boolean, summary?: string) {
    if (!shouldLog("info")) return;
    const icon = success ? "✓" : "✗";
    const color = success ? COLORS.green : COLORS.red;
    console.log(
      `${color}[${timestamp()}]    ${icon} ${fmtInstance(instanceId)}${toolName}${COLORS.reset}${summary ? ` → ${truncate(summary, 60)}` : ""}`
    );
  },

  /**
   * Concise system-prompt signal (just before LLM call): only the length, to
   * catch prompt bloat. The full prompt body is intentionally NOT logged —
   * use the per-instance `debug_enabled` flag (persists `{system, messages,
   * tools}`) for full-payload inspection.
   */
  systemPrompt(instanceId: string, prompt: string) {
    line("debug", COLORS.yellow, "📋 SYSTEM PROMPT", instanceId, `length=${prompt.length} chars`);
  },

  /** Supervisor starting */
  supervisorStart(instanceId: string, toolCount: number) {
    line("debug", COLORS.magenta, "🎯 SUPERVISOR", instanceId, `starting with ${toolCount} tools available`);
  },

  /** Supervisor completed */
  supervisorDone(instanceId: string, durationMs: number, responsePreview: string) {
    line("info", COLORS.magenta, "🏁 SUPERVISOR DONE", instanceId, `duration=${durationMs}ms`);
    if (shouldLog("debug")) {
      console.log(
        `${COLORS.dim}   response: "${truncate(responsePreview, 500)}"${COLORS.reset}`
      );
    }
  },

  /** Pre-enrichment context loaded */
  preEnrichment(instanceId: string, hasSummary: boolean) {
    line("debug", COLORS.yellow, "🧠 CONTEXT", instanceId, `summary=${hasSummary ? "yes" : "no"}`);
  },

  /** Pipeline complete */
  response(instanceId: string, durationMs: number) {
    if (!shouldLog("info")) return;
    line("info", COLORS.cyan, "📤 RESPONSE", instanceId, `total=${durationMs}ms`);
    console.log(
      `${COLORS.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}\n`
    );
  },
};
