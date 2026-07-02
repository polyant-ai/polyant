// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture: a plugin tool whose schema violates OpenAI strict-mode (an .optional()
// field lands outside `required`). The loader must WARN at load time but still
// register the tool.
import { defineTool } from "@polyant-ai/plugin-sdk";
import { z } from "zod";

export default defineTool({
  name: "loose",
  description: "fixture with a strict-mode-incompatible schema",
  category: "plugin",
  parameters: z.object({ a: z.string(), b: z.string().optional() }),
  execute: async () => "ok",
});
