// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Example custom tool: echo
 *
 * The simplest possible Polyant tool — returns whatever it receives.
 * Copy this file into `packages/engine/src/agents/tools/` and restart the engine:
 * `loadAllTools()` collects the DEFAULT EXPORT at boot, syncs the `tools` table,
 * and the tool appears in the admin panel's Tools tab for any agent to enable.
 *
 * Two rules the loader will not remind you about:
 *
 * 1. It recognizes ONLY a default export produced by `defineTool`. A file that
 *    self-registers, or exports the definition under a name, is skipped with a
 *    `console.warn` at boot — no build error, no failing test, just a tool that
 *    never exists.
 *
 * 2. `parameters` is a STATIC Zod schema: `defineTool` serializes it to JSON
 *    Schema at module load, so it must not read `ctx`. It must also satisfy
 *    OpenAI strict mode — no `.optional()`, no `.default()`, no `.url()` /
 *    `.email()`, no unbounded `z.record`. Use `.nullable()` and handle the null
 *    inside `execute`. `agents/tools/strict-mode.test.ts` enforces this against
 *    every registered tool.
 */
import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";

export default defineTool({
  name: "echo",
  description: "Echo the input string back verbatim. Useful as a smoke test.",
  category: "general",
  parameters: z.object({
    message: z.string().describe("The message to echo."),
  }),
  execute: async ({ message }: { message: string }) => {
    return { echoed: message, length: message.length };
  },
});
