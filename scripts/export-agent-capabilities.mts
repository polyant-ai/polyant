// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Exports the agent-authoring capabilities manifest from the live engine code:
 * the tool catalog (name/description/category/requiredSecrets/inputExamples), the
 * provider/model config, and the static contracts (prompt section keys, channel
 * types, schedule shapes, Management API surface).
 *
 * Consumers (a CLI/SDK, or an external agent-authoring repo) read this small,
 * accurate manifest instead of grepping the whole engine.
 *
 * MUST run with the repo `.env` present — importing the tool files transitively
 * imports `config.ts`, which validates env at load and `process.exit(1)`s on failure.
 *
 * Named `.mts` (not `.ts`) so it runs as ESM even though the repo root is not
 * `type: module`: a root `.ts` runs as CJS under tsx and gets a different live
 * instance of the tool-registry module than the dynamically-imported tool files
 * populate, so `listAvailableTools()` would return an empty catalog.
 *
 * Usage (from the repo root):
 *   tsx scripts/export-agent-capabilities.mts --out capabilities.json
 *   tsx scripts/export-agent-capabilities.mts            # prints JSON to stdout
 */
import { writeFileSync } from "fs";
import { loadAllTools, listAvailableTools } from "../packages/engine/src/agents/tools/registry.js";
import { providerConfigs } from "../packages/engine/src/ai-gateway/config.js";

async function main(): Promise<void> {
  await loadAllTools();
  const tools = listAvailableTools(); // name, description, category, requiredSecrets, inputExamples

  const models: Record<string, Array<{ id: string; tier: string | null }>> = {};
  for (const [name, cfg] of Object.entries(providerConfigs)) {
    const tierByModel = new Map(Object.entries(cfg.tiers).map(([tier, id]) => [id as string, tier]));
    models[name] = Object.keys(cfg.costPerMillionTokens).map((id) => ({
      id,
      tier: tierByModel.get(id) ?? null,
    }));
  }

  const manifest = {
    generatedFrom: "polyant engine",
    tools,
    models,
    promptSectionKeys: [
      "01-identity",
      "02-soul",
      "03-tooling",
      "04-safety",
      "05-skills",
      "06-memory",
      "07-user-identity",
      "08-datetime",
    ],
    channelTypes: ["telegram", "slack", "whatsapp", "agent", "http"],
    scheduleShapes: {
      cron: { type: "cron", expression: "string", timezone: "IANA tz?" },
      interval: { type: "interval", everyMs: "number", anchorAt: "ISO?" },
      "one-shot": { type: "one-shot", runAt: "ISO" },
    },
    scheduledTaskFields: [
      "name",
      "description?",
      "prompt",
      "schedule",
      "outboundChannel?",
      "outboundTarget?",
      "keepHistory?",
      "maxRetries?",
    ],
    managementApi: [
      "POST /api/instances {slug,name,description?,provider?,model?}",
      "PATCH /api/instances/:slug {name?,description?,provider?,model?,memoryEnabled?,knowledgeEnabled?,optoutEnabled?,...}",
      "PATCH /api/instances/:slug/prompts {sections:[{key,content}]}",
      "GET|PATCH /api/instances/:slug/tools {enabled:[]}",
      "PUT /api/instances/:slug/secrets {secrets:[{key,value}]}",
      "PUT /api/instances/:slug/channels/:type {config,enabled}",
      "GET|POST /api/instances/:slug/scheduled-tasks",
      "PATCH|DELETE /api/instances/:slug/scheduled-tasks/:id",
      "POST /api/instances/:slug/scheduled-tasks/:id/run",
    ],
  };

  const json = JSON.stringify(manifest, null, 2);
  const outIdx = process.argv.indexOf("--out");
  if (outIdx >= 0 && process.argv[outIdx + 1]) {
    writeFileSync(process.argv[outIdx + 1], json + "\n");
    console.error(`Wrote ${tools.length} tools, ${Object.keys(models).length} providers to ${process.argv[outIdx + 1]}`);
  } else {
    process.stdout.write(json + "\n");
  }
}

main().catch((err) => {
  console.error("export failed:", err);
  process.exit(1);
});
