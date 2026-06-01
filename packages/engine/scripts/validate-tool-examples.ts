// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Validate `inputExamples` of every registered tool against its Zod schema.
 *
 * `buildTool` runs this same check at boot and only logs warnings — failed
 * examples are silently dropped from the description shown to the LLM.
 * Run this script on demand to catch every drift in one sweep.
 *
 * Usage (from monorepo root):
 *   npx tsx packages/engine/scripts/validate-tool-examples.ts
 *
 * Exit code: 0 if all examples valid, 1 if any failed.
 */

import { z } from "zod";
import { loadAllTools, getToolRegistry, type ToolContext } from "../src/agents/tools/registry.js";

interface FailureReport {
  tool: string;
  example: string;
  errors: z.ZodFormattedError<unknown>;
}

async function main(): Promise<number> {
  await loadAllTools();
  const registry = getToolRegistry();

  const fakeCtx: ToolContext = {
    instanceId: "validate-script",
    audit: {
      log: () => undefined,
    } as unknown as ToolContext["audit"],
    conversationId: "validate",
    secrets: {
      // Provide common secrets so requiredSecrets gating doesn't matter — we
      // only call `def.create()`, never `execute()`.
      hubspot_api_key: "x",
      openai_api_key: "x",
      anthropic_api_key: "x",
      tavily_api_key: "x",
      github_token: "x",
      langsmith_api_key: "x",
      auth_api_key: "x",
      http_api_key: "x",
      s3_bucket_name: "x",
      deepgram_api_key: "x",
    },
    apiKeys: { openai: "x" },
    provider: "openai",
  };

  const failures: FailureReport[] = [];
  let totalExamples = 0;
  let toolsWithExamples = 0;

  for (const [name, def] of registry) {
    if (!def.inputExamples?.length) continue;
    toolsWithExamples += 1;

    let parameters: z.ZodType;
    try {
      ({ parameters } = def.create(fakeCtx));
    } catch (err) {
      console.error(`[${name}] could not instantiate via def.create():`, err);
      continue;
    }

    // Same logic as registry.ts:buildTool — partial() makes top-level fields
    // optional but does NOT recurse into nested z.object().
    const exampleSchema =
      "partial" in parameters && typeof (parameters as { partial?: unknown }).partial === "function"
        ? (parameters as unknown as z.ZodObject<z.ZodRawShape>).partial()
        : parameters;

    for (const ex of def.inputExamples) {
      totalExamples += 1;
      const result = exampleSchema.safeParse(ex.input);
      if (!result.success) {
        failures.push({ tool: name, example: ex.label, errors: result.error.format() });
      }
    }
  }

  console.log(`Tools with inputExamples: ${toolsWithExamples}`);
  console.log(`Total examples checked: ${totalExamples}`);
  console.log(`Failures: ${failures.length}`);

  if (failures.length === 0) {
    console.log("\n✅ All inputExamples validate.");
    return 0;
  }

  console.log("\n❌ Failures:\n");
  for (const f of failures) {
    console.log(`  • ${f.tool} / "${f.example}"`);
    console.log(JSON.stringify(f.errors, null, 4).split("\n").map((l) => "    " + l).join("\n"));
    console.log();
  }
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("audit crashed:", err);
    process.exit(2);
  });
