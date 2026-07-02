// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineTool } from "@polyant-ai/plugin-sdk";
import { z } from "zod";

export default defineTool({
  name: "nope",
  description: "should never load (engine range mismatch)",
  category: "plugin",
  parameters: z.object({}),
  execute: async () => "nope",
});
