// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineTool } from "@polyant-ai/plugin-sdk";
import { z } from "zod";

export default defineTool({
  name: "ping",
  description: "fixture ping",
  category: "plugin",
  parameters: z.object({ msg: z.string() }),
  execute: async (input) => `pong:${input.msg}`,
});
