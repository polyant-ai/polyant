---
name: plugin-authoring
description: Use when creating, converting, or loading Polyant agent tools/plugins — authoring a *.tool.ts with defineTool, the serialized (JSON Schema) contract, converting a legacy registerTool tool, or wiring an external plugin via PLUGIN_DIRS / src/plugins. Covers the module-resolution rules that decide where a plugin can live.
---

# Authoring & loading Polyant tools/plugins

Tools (core and plugin) share ONE contract: `@polyant-ai/plugin-sdk`. Full
reference: [docs/plugins.md](../../../docs/plugins.md) and the design record at
`docs/superpowers/specs/2026-07-02-serialized-plugin-mechanism.md`.

## The contract

A tool file **default-exports** `defineTool(...)`. The boundary is **data**:
`defineTool` serializes the static Zod `parameters` → JSON Schema at load; the
engine consumes `inputSchema` + `execute(input, ctx)`. Never pass a live Zod
object to the engine; never rely on a shared SDK singleton (the SDK is stateless,
the engine loader owns the registry).

```ts
import { defineTool } from "@polyant-ai/plugin-sdk";
import { z } from "zod";

export default defineTool({
  name: "myTool",
  description: "…",
  category: "…",
  requiredSecrets: ["some_key"],            // string | { key, type:"select", choices } specs
  parameters: z.object({ q: z.string(), n: z.number().nullable() }), // STATIC — no ctx
  execute: async (input, ctx) => {          // ctx: instanceId, secrets, audit, state, apiKeys, provider, attachments
    // validate/normalize here; return a plain result (prefer an explicit `status`/`error`)
  },
});
```

### Schema rules (OpenAI strict-mode — guarded by `agents/tools/strict-mode.test.ts`)
- `.nullable()`, NOT `.optional()` / `.default()` (apply defaults in `execute`).
- NO `.transform()` / `.refine()` / `.superRefine()` / `.preprocess()` in `parameters` — move that logic into `execute` and return `{ error }` instead of throwing.
- NO `.url()`/`.email()`/`.uuid()`/`.datetime()` — validate strings in `execute`.
- `z.record(z.string(), z.string())` OK; `z.record(z.unknown())` not.
- Run `npx vitest run --root packages/engine strict-mode` after adding/changing a schema.

## Converting a legacy tool (`registerTool` + `create`)

1. Import `defineTool` from `@polyant-ai/plugin-sdk` (drop `registerTool`).
2. `registerTool({` → `export default defineTool({`.
3. Hoist `parameters` out of `create` to a top-level property.
4. Drop the `create: (ctx) => ({…})` wrapper; give `execute` `ctx` as its 2nd param (the body's `ctx.` refs now bind to that param — usually zero body changes). Fix the closing braces (one fewer nesting level).
5. Move any `.transform`/`.preprocess` logic into `execute`.
6. Update the tool's test: side-effect `import "./x.tool.js"` → `import xTool from "./x.tool.js"`; `getToolRegistry().get("x")` → the default import; `requiredSecrets` assertions → normalized specs (`[{ key, type:"text", sensitive:true }]`); ex-`inputSchema.parse` (Zod) tests → call `execute(input, ctx)` directly.

Both shapes coexist (the loader/`buildTool` dispatch on `inputSchema`), so migrate incrementally.

## Loading an external plugin

The loader scans core tools + plugin roots (`PLUGIN_DIRS` ∪ `src/plugins/*`), each
under its `plugin.json` namespace, skipping engine-range mismatches.

**Module-resolution rule** — a plugin file resolves its imports from its realpath:
- **Real dir inside the monorepo** (`packages/engine/src/plugins/<name>`) → resolves the monorepo's `node_modules`, `tsx watch` hot-reloads. Best for iterating.
- **Out-of-tree dir with its OWN `node_modules`** (`npm install` there, SDK as a git dep) → point at it with `PLUGIN_DIRS=/abs/path npm run dev`. No hot-reload → restart after edits.
- **Never a symlink** — `tsx` resolves the symlink's realpath (the external repo) and cannot find the monorepo deps.

`src/plugins/` is gitignored (runtime drop dir). External plugins live in their own repos and reference `@polyant-ai/plugin-sdk` as a public git dependency (`git+https://github.com/polyant-ai/polyant-sdk.git#v1.0.0`).

## Verify
- `npm run typecheck -w @polyant/engine`
- `npx vitest run --root packages/engine "src/agents/tools/" "src/plugin-system/"`
- To confirm a plugin loads: check the `tools` DB table for its `<namespace>:*` rows after boot, or assert via `loadAllTools()` + `getToolRegistry()`.
