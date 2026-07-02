# Plugin System — Serialized Tool Contract

How Polyant loads agent **tools** from independent plugin repos, and how the
engine's own core tools are authored, using one shared contract:
`@polyant-ai/plugin-sdk`.

## Why

Polyant is a **framework-first**, domain-agnostic engine. Domain-specific tools
(a dental CRM's booking flow, an energy CRM's bill check) must NOT live in the
engine. A plugin is an **external git repo** of tools the engine loads, so the
engine stays generic and each deployment composes the tools it needs.

## The contract in one paragraph

A tool file **default-exports** `defineTool({ name, description, parameters, execute })`.
`parameters` is a **static** Zod schema; `defineTool` (in the SDK) serializes it
to **JSON Schema at module load, in the plugin's own realm**. The engine's loader
collects the default export and stores `{ …metadata, inputSchema, execute }` in
its registry. So the only things that cross the tool↔engine boundary are **data**
(a JSON Schema) and a **function** (`execute(input, ctx)`) — never a live Zod
object or a shared stateful singleton. That data boundary is the whole design:
it lets the engine and every plugin resolve their **own** copies of the SDK (and
`zod`, `ai`, …) without breakage — which is what makes out-of-tree dev and
build-time bake-in possible.

## Components

| Unit | Where | Role |
|------|-------|------|
| `@polyant-ai/plugin-sdk` | repo `github.com/polyant-ai/polyant-sdk` | Stateless contract: `defineTool` + types. Consumed as a **public git dependency** by the engine and by every plugin. Ships built (`dist`). |
| Loader | `agents/tools/registry.ts` → `loadAllTools()` | Scans the core tools dir + N plugin roots, imports each `*.tool.ts`, collects `export default`, applies the plugin namespace, owns the registry Map. |
| Discovery | `plugin-system/plugin-roots.ts` + `plugin-manifest.ts` | Resolves plugin roots (`PLUGIN_DIRS` ∪ `src/plugins/*`), reads/validates `plugin.json`, checks the engine version range. |
| `buildTool()` | `registry.ts` | Turns a registered definition into an AI-SDK `Tool`. Serialized path feeds `ai.jsonSchema(inputSchema)` with a recursive missing-key fill (the strict-mode-safe analogue of the old Zod preprocess). |

## Authoring a tool (core or plugin — identical)

```ts
import { defineTool } from "@polyant-ai/plugin-sdk";
import { z } from "zod";

export default defineTool({
  name: "webSearch",
  description: "…",
  category: "research",
  requiredSecrets: ["tavily_api_key"],
  parameters: z.object({                     // STATIC — must not read ctx
    query: z.string(),
    maxResults: z.number().nullable(),
  }),
  execute: async ({ query, maxResults }, ctx) => {
    const key = ctx.secrets?.tavily_api_key;  // ctx: secrets, audit, state, apiKeys, instanceId…
    // … return a plain result …
  },
});
```

### Schema rules (OpenAI strict-mode compatible — enforced by `strict-mode.test.ts`)
- `.nullable()`, **not** `.optional()` / `.default()` (apply defaults in `execute`).
- No `.transform()` / `.refine()` / `.preprocess()` in `parameters` — move that logic to `execute` and return `{ error }` instead of throwing (see `hubspot-contact.tool.ts`, `http-request.tool.ts`).
- No `.url()`/`.email()`/`.uuid()`/`.datetime()` formats — validate strings in `execute`.
- `z.record(z.string(), z.string())` OK; `z.record(z.unknown())` not.

## `plugin.json` (plugin repo root)

```json
{ "name": "innovasemplice", "version": "1.0.0", "engine": ">=0.1.0", "toolsDir": "tools", "namespace": "innova" }
```

`namespace` prefixes every tool name → `innova:verificaBolletta`. Defaults to
`name`. A plugin whose `engine` range excludes the running engine version is
skipped with a warning (the deployment continues). Duplicate final names fail the
boot loudly.

## Loading a plugin — dev

The loader resolves roots from two sources (env wins de-dup):
1. `PLUGIN_DIRS` — comma-separated absolute paths (env, `config.plugins.dirs`).
2. Convention dir — every subdir of `packages/engine/src/plugins/*` with a `plugin.json` (gitignored — see `packages/engine/.gitignore`).

**Module-resolution constraint (important):** `tsx`/Node resolve a file's imports
from the file's **real on-disk location**. So a plugin file must be able to
resolve its deps (`@polyant-ai/plugin-sdk`, `zod`, `ai`, …) by walking up from
where it lives. Two working setups:

- **Out-of-tree (point at your repo):** the plugin repo has its **own**
  `node_modules` (`npm install` there, with the SDK as a git dep). Then
  `PLUGIN_DIRS=/abs/path/to/plugin npm run dev` loads it. No hot-reload for files
  outside the engine tree → restart after edits.
- **In-tree copy/clone:** put the plugin as a **real dir** under
  `packages/engine/src/plugins/<name>` (it resolves the monorepo's `node_modules`);
  `tsx watch` hot-reloads. Do **not** symlink — `tsx` resolves the symlink's
  realpath (the external repo) and fails to find the monorepo deps.

## Loading a plugin — build-time (deferred)

CDK/Docker bake-in: clone each pinned plugin into `dist/plugins/<name>` (or bundle
it) so its deps resolve in the image. Not yet implemented — the loader is already
build-time-ready (it scans `<src|dist>/plugins/*`).

## The SDK as a git dependency

Both the engine and every plugin reference the SDK by pinned tag:
```
"@polyant-ai/plugin-sdk": "git+https://github.com/polyant-ai/polyant-sdk.git#v1.0.0"
```
`npm install` clones it and runs its `prepare` (build) → `dist`. The SDK's version
is the compatibility contract; bump it deliberately and update the ref.

## Converting a legacy tool to the serialized contract

`registerTool({ create: (ctx) => ({ parameters, execute }) })` →
`export default defineTool({ parameters, execute: (input, ctx) })`:
1. Import `defineTool` from `@polyant-ai/plugin-sdk` (drop `registerTool`).
2. Hoist `parameters` out of `create` to a top-level property.
3. Drop the `create` wrapper; `execute` gains `ctx` as its 2nd parameter.
4. Move any live-schema logic (`.transform`/`.preprocess`) into `execute`.
5. In the tool's test: side-effect import → default import; `requiredSecrets`
   assertions become the normalized specs; ex-`inputSchema.parse` tests call
   `execute` directly.

**Legacy path status:** `registerTool` / the `create`-factory shape still work
(the loader + `buildTool` accept both, dispatching on the presence of
`inputSchema`) so migration can be incremental. The legacy path stays until every
tool is converted, then it can be removed.

## Reference
- SDK repo + authoring guide: `github.com/polyant-ai/polyant-sdk` (its `README.md`).
- Design record: `docs/superpowers/specs/2026-07-02-serialized-plugin-mechanism.md`.
- Authoring skill: `.claude/skills/plugin-authoring/SKILL.md`.
